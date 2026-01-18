import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { authService } from '../../services/auth';
import { stripeService, stripe } from '../../services/stripe';
import { cognitoService } from '../../services/auth/cognito';
import { query, transaction } from '../../db';
import { logger } from '../../utils/logger';
import { normalizeEmail } from '../../utils/email';
import { DEFAULT_FEATURES_BY_TIER, PRICING_BY_TIER } from '../../db/models/subscription';
import { DB_ROLES, mapDbRoleToCognitoGroup } from '../../constants/auth';
import { config } from '../../config';
// sendWelcomeEmail is now sent via queue - import kept for reference
// import { sendWelcomeEmail } from '../../services/email/template-sender';
import { queueService, QueueName } from '../../services/queue';
import Stripe from 'stripe';
import { syncAccountFromStripe } from '../stripe/connect';

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      logger.error('[Signup OpenAPI Validation Error]', {
        path: c.req.path,
        method: c.req.method,
        errors: result.error.issues,
        errorFlat: result.error.flatten(),
      });
      return c.json(
        {
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: result.error.issues,
        },
        400
      );
    }
    return undefined;
  },
});

const SignupRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  organizationName: z.string().min(2),
  phone: z.string().optional(),
  acceptTerms: z.boolean(),
  acceptPrivacy: z.boolean(),
  subscriptionTier: z.enum(['starter', 'pro', 'enterprise']).default('starter'),
  // For custom/enterprise plan
  businessDescription: z.string().optional(),
  expectedVolume: z.string().optional(),
  useCase: z.string().optional(),
  additionalRequirements: z.string().optional(),
  // Signup source platform - determines subscription platform
  // 'ios' -> 'apple', 'android' -> 'google', undefined -> 'stripe' (web)
  signupPlatform: z.enum(['ios', 'android', 'web']).optional(),
  // For in-app purchase (IAP) - mobile app signups with Pro purchase
  iapPlatform: z.enum(['ios', 'android']).optional(),
  iapReceipt: z.string().optional(), // Purchase token (Android) or receipt (iOS)
  iapTransactionId: z.string().optional(), // Transaction ID from the IAP
  iapProductId: z.string().optional(), // Product ID (e.g., 'lumaproplan')
});

const SignupResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    organizationId: z.string(),
  }),
  organization: z.object({
    id: z.string(),
    name: z.string(),
  }),
  subscription: z.object({
    id: z.string(),
    tier: z.string(),
    status: z.string(),
    trialEndsAt: z.string().nullable(),
  }),
  tokens: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number(),
  }),
  stripeOnboardingUrl: z.string().optional(),
  stripeCheckoutUrl: z.string().optional(),
  customPlanRequested: z.boolean().optional(),
  paymentIntentClientSecret: z.string().optional(),
  stripeSubscriptionId: z.string().optional(),
});

const signupRoute = createRoute({
  method: 'post',
  path: '/auth/signup',
  summary: 'Create a new account',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: SignupRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Account created successfully',
      content: {
        'application/json': {
          schema: SignupResponseSchema,
        },
      },
    },
    400: {
      description: 'Bad request',
    },
    409: {
      description: 'Email already exists',
    },
  },
});

app.openapi(signupRoute, async (c) => {
  // Log raw request first
  let body: any;
  try {
    body = await c.req.json();
    logger.info('[Signup] ========== RAW REQUEST RECEIVED ==========', {
      hasBody: !!body,
      bodyKeys: body ? Object.keys(body) : [],
      email: body?.email,
      hasPassword: !!body?.password,
      passwordLength: body?.password?.length || 0,
      firstName: body?.firstName,
      lastName: body?.lastName,
      organizationName: body?.organizationName,
      subscriptionTier: body?.subscriptionTier,
      acceptTerms: body?.acceptTerms,
      acceptPrivacy: body?.acceptPrivacy,
      hasIapData: !!(body?.iapPlatform && body?.iapReceipt),
      iapPlatform: body?.iapPlatform,
    });
  } catch (parseError: any) {
    logger.error('[Signup] Failed to parse request body', {
      error: parseError.message,
    });
    return c.json({
      error: 'INVALID_JSON',
      message: 'Failed to parse request body as JSON'
    }, 400);
  }

  // Validate with Zod
  let validated;
  try {
    validated = SignupRequestSchema.parse(body);
    logger.info('[Signup] Zod validation passed');
  } catch (zodError: any) {
    logger.error('[Signup] ========== ZOD VALIDATION FAILED ==========', {
      errors: zodError.errors || zodError.issues,
      message: zodError.message,
      body: {
        email: body?.email,
        hasPassword: !!body?.password,
        passwordLength: body?.password?.length || 0,
        firstName: body?.firstName,
        lastName: body?.lastName,
        organizationName: body?.organizationName,
        subscriptionTier: body?.subscriptionTier,
        acceptTerms: body?.acceptTerms,
        acceptPrivacy: body?.acceptPrivacy,
      }
    });
    return c.json({
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: zodError.errors || zodError.issues,
    }, 400);
  }

  // Log incoming signup request
  logger.info('[Signup] ========== NEW SIGNUP REQUEST ==========', {
    email: validated.email,
    tier: validated.subscriptionTier,
    hasIapData: !!(validated.iapPlatform && validated.iapReceipt),
    iapPlatform: validated.iapPlatform || null,
    iapProductId: validated.iapProductId || null,
    iapTransactionId: validated.iapTransactionId || null,
    iapReceiptLength: validated.iapReceipt?.length || 0,
    iapReceiptPreview: validated.iapReceipt ? validated.iapReceipt.substring(0, 30) + '...' : null,
  });

  if (!validated.acceptTerms || !validated.acceptPrivacy) {
    logger.warn('[Signup] Terms/Privacy not accepted', {
      acceptTerms: validated.acceptTerms,
      acceptPrivacy: validated.acceptPrivacy,
    });
    return c.json({
      error: 'TERMS_NOT_ACCEPTED',
      message: 'You must accept the terms of service and privacy policy to create an account'
    }, 400);
  }

  const normalizedEmail = normalizeEmail(validated.email);
  
  try {
    // Check if user already exists in database
    const existingUser = await authService.getUserByEmail(normalizedEmail);
    if (existingUser) {
      logger.info('Signup attempt with existing email - found in database', { 
        email: normalizedEmail,
        userId: existingUser.id,
        organizationId: existingUser.organization_id,
        createdAt: existingUser.created_at,
        cognitoUserId: existingUser.cognito_user_id
      });
      return c.json({ 
        error: 'EMAIL_EXISTS',
        message: 'An account with this email address already exists. Please sign in or use a different email.'
      }, 409);
    }
    
    // Check if user exists in Cognito
    if (cognitoService) {
      try {
        const cognitoUser = await cognitoService.getUser(normalizedEmail);
        if (cognitoUser) {
          logger.info('Email exists in Cognito but not in database', { email: normalizedEmail });
          return c.json({ 
            error: 'EMAIL_EXISTS_COGNITO',
            message: 'An account with this email exists but is not fully set up. Please contact support.'
          }, 409);
        }
      } catch (error: any) {
        // User not found in Cognito is expected, continue
        if (error.name !== 'UserNotFoundException') {
          logger.error('Error checking Cognito user', error);
        }
      }
    }

    let paymentIntentClientSecret: string | undefined;
    
    const result = await transaction(async (client) => {
      // 1. Create organization
      const orgResult = await client.query(
        `INSERT INTO organizations (name, settings) 
         VALUES ($1, $2) 
         RETURNING *`,
        [validated.organizationName, {}]
      );
      const organization = orgResult.rows[0];

      // 2. Create Stripe customer
      const stripeCustomer = await stripeService.createCustomer({
        email: normalizedEmail,
        name: `${validated.firstName} ${validated.lastName}`,
        phone: validated.phone,
        description: `Luma customer for ${validated.organizationName}`,
        metadata: {
          organization_id: organization.id,
          organization_name: organization.name,
          email: normalizedEmail,
        },
      });

      // 3. Create user in database
      const userResult = await client.query(
        `INSERT INTO users (
          email, password_hash, first_name, last_name, phone,
          organization_id, role, stripe_customer_id,
          terms_accepted_at, privacy_accepted_at,
          email_alerts, marketing_emails, weekly_reports
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9, $10, $11)
        RETURNING *`,
        [
          normalizedEmail,
          null, // Password will be set by Cognito
          validated.firstName,
          validated.lastName,
          validated.phone,
          organization.id,
          DB_ROLES.OWNER,
          stripeCustomer.id,
          true, // email_alerts: true
          true, // marketing_emails: true  
          true, // weekly_reports: true
        ]
      );
      const user = userResult.rows[0];

      // 4. Create Cognito user
      let cognitoUserId: string | undefined;
      if (cognitoService) {
        try {
          // Format phone number for Cognito (E.164 format)
          const formattedPhone = validated.phone ? `+1${validated.phone.replace(/\D/g, '')}` : undefined;
          
          const cognitoUser = await cognitoService.createUser({
            email: normalizedEmail,
            temporaryPassword: validated.password,
            attributes: {
              'given_name': validated.firstName,
              'family_name': validated.lastName,
              ...(formattedPhone && { phone_number: formattedPhone }),
            },
          });

          const cognitoGroup = mapDbRoleToCognitoGroup(DB_ROLES.OWNER);
          await cognitoService.addUserToGroup(normalizedEmail, cognitoGroup);
          await cognitoService.setUserPassword(normalizedEmail, validated.password, true);
          
          cognitoUserId = cognitoUser.username;

          // Update user with cognito_user_id
          await client.query(
            `UPDATE users SET cognito_user_id = $1 WHERE id = $2`,
            [cognitoUserId, user.id]
          );
          user.cognito_user_id = cognitoUserId;
        } catch (error) {
          logger.error('Failed to create Cognito user', { 
            error,
            email: normalizedEmail,
            errorName: (error as any)?.name,
            errorMessage: (error as any)?.message 
          });
          throw new Error('Failed to create authentication account');
        }
      }

      // 5. Create subscription based on tier and payment method
      const pricing = PRICING_BY_TIER[validated.subscriptionTier];
      const features = DEFAULT_FEATURES_BY_TIER[validated.subscriptionTier];

      let subscriptionStatus = 'active';
      let stripeSubscriptionId = null;

      // Determine subscription platform based on signup source
      // Mobile app signups (ios/android) get 'apple'/'google' platform
      // Web signups get 'stripe' platform
      let subscriptionPlatform: 'stripe' | 'apple' | 'google' = 'stripe';
      if (validated.signupPlatform === 'ios') {
        subscriptionPlatform = 'apple';
      } else if (validated.signupPlatform === 'android') {
        subscriptionPlatform = 'google';
      }

      // Check if this is an IAP (in-app purchase) signup with a Pro purchase
      const isIapSignup = validated.iapPlatform && validated.iapReceipt;

      logger.info('[Signup] Platform check', {
        signupPlatform: validated.signupPlatform,
        subscriptionPlatform,
        isIapSignup,
        iapPlatform: validated.iapPlatform,
        hasReceipt: !!validated.iapReceipt,
        receiptLength: validated.iapReceipt?.length || 0,
      });

      if (isIapSignup) {
        // IAP signup with Pro purchase - the purchase was already made in the app
        // Platform should already be set from signupPlatform, but ensure consistency
        subscriptionPlatform = validated.iapPlatform === 'ios' ? 'apple' : 'google';
        subscriptionStatus = 'active'; // IAP purchase already completed

        logger.info('[Signup] ========== IAP SIGNUP DETECTED ==========', {
          platform: validated.iapPlatform,
          productId: validated.iapProductId,
          transactionId: validated.iapTransactionId,
          tier: validated.subscriptionTier,
          receiptPreview: validated.iapReceipt?.substring(0, 50) + '...',
          willStoreAsGoogleToken: validated.iapPlatform === 'android',
          willStoreAsAppleTransaction: validated.iapPlatform === 'ios',
        });
      } else if (subscriptionPlatform === 'stripe' && validated.subscriptionTier === 'pro' && config.stripe.proPriceId) {
        // Web/Stripe signup - create subscription with trial
        // With a trial, we use pending_setup_intent to collect payment method upfront
        // The customer won't be charged until the trial ends
        const subscription = await stripe.subscriptions.create({
          customer: stripeCustomer.id,
          items: [{ price: config.stripe.proPriceId }],
          discounts: [{ coupon: 'first-month-discount' }],
          trial_period_days: 7,
          payment_behavior: 'default_incomplete',
          payment_settings: {
            save_default_payment_method: 'on_subscription',
          },
          expand: ['pending_setup_intent'],
        });

        stripeSubscriptionId = subscription.id;
        subscriptionStatus = subscription.status || 'incomplete';

        // With a trial, we get a SetupIntent instead of a PaymentIntent
        const setupIntent = subscription.pending_setup_intent as Stripe.SetupIntent;

        if (setupIntent?.client_secret) {
          paymentIntentClientSecret = setupIntent.client_secret;
        } else {
          logger.error('No setup intent found on trial subscription', {
            subscriptionId: subscription.id,
            status: subscription.status
          });
        }
      } else if (validated.subscriptionTier === 'enterprise') {
        subscriptionStatus = 'pending_approval';
      }

      // Build subscription insert query based on whether it's IAP or Stripe
      // Prepare values for logging
      const appleTransactionToStore = validated.iapPlatform === 'ios' ? validated.iapTransactionId : null;
      const googleTokenToStore = validated.iapPlatform === 'android' ? validated.iapReceipt : null;

      logger.info('[Signup] Preparing subscription INSERT', {
        userId: user.id,
        organizationId: organization.id,
        tier: validated.subscriptionTier,
        status: subscriptionStatus,
        platform: subscriptionPlatform,
        isIapSignup,
        appleTransactionId: appleTransactionToStore,
        googlePurchaseTokenLength: googleTokenToStore?.length || 0,
        googlePurchaseTokenPreview: googleTokenToStore ? googleTokenToStore.substring(0, 50) + '...' : null,
      });

      const subscriptionResult = await client.query(
        `INSERT INTO subscriptions (
          user_id, organization_id, stripe_customer_id,
          tier, status, stripe_subscription_id,
          monthly_price, transaction_fee_rate, features,
          metadata, platform,
          apple_original_transaction_id, google_purchase_token
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          user.id,
          organization.id,
          stripeCustomer.id,
          validated.subscriptionTier,
          subscriptionStatus,
          stripeSubscriptionId,
          pricing.monthly_price,
          pricing.transaction_fee_rate,
          features,
          validated.subscriptionTier === 'pro' && !isIapSignup ? { price_id: config.stripe.proPriceId } : {},
          subscriptionPlatform,
          // Store IAP identifiers
          appleTransactionToStore,
          googleTokenToStore,
        ]
      );
      const subscription = subscriptionResult.rows[0];

      logger.info('[Signup] Subscription created in database', {
        subscriptionId: subscription.id,
        platform: subscription.platform,
        status: subscription.status,
        tier: subscription.tier,
        hasGoogleToken: !!subscription.google_purchase_token,
        hasAppleTransaction: !!subscription.apple_original_transaction_id,
        googleTokenInDb: subscription.google_purchase_token ? subscription.google_purchase_token.substring(0, 30) + '...' : null,
      });

      if (isIapSignup) {
        logger.info('[Signup] ========== IAP SUBSCRIPTION SAVED ==========', {
          subscriptionId: subscription.id,
          userId: user.id,
          organizationId: organization.id,
          platform: subscriptionPlatform,
          tier: validated.subscriptionTier,
          status: subscriptionStatus,
          googlePurchaseToken: validated.iapPlatform === 'android' ? validated.iapReceipt?.substring(0, 30) + '...' : null,
          googlePurchaseTokenFullLength: validated.iapPlatform === 'android' ? validated.iapReceipt?.length : null,
          appleTransactionId: validated.iapPlatform === 'ios' ? validated.iapTransactionId : null,
          storedInColumn: validated.iapPlatform === 'android' ? 'google_purchase_token' : 'apple_original_transaction_id',
        });
      }

      // 6. Handle tier-specific flows
      // Note: Stripe Connect account creation has been disabled
      // If you need Connect accounts, enable Stripe Connect in your Stripe Dashboard first
      
      // 7. Handle custom plan request
      if (validated.subscriptionTier === 'enterprise') {
        await client.query(
          `INSERT INTO custom_plan_requests (
            user_id, organization_id, business_description,
            expected_volume, use_case, additional_requirements
          ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            user.id,
            organization.id,
            validated.businessDescription || '',
            validated.expectedVolume || '',
            validated.useCase || '',
            validated.additionalRequirements || ''
          ]
        );
      }

      return { user, organization, subscription, stripeSubscriptionId, paymentIntentClientSecret };
    });

    // 7.5 Create Stripe Connect account for the organization (non-blocking)
    // This allows users to start using Tap to Pay immediately after signup
    try {
      logger.info('Creating Stripe Connect account for new organization', {
        organizationId: result.organization.id,
        email: normalizedEmail,
      });

      const connectAccount = await stripeService.createConnectedAccount({
        email: normalizedEmail,
        country: 'US',
        business_type: 'individual',
        metadata: {
          organization_id: result.organization.id,
          organization_name: validated.organizationName,
          user_id: result.user.id,
        },
      });

      // Sync the account to our database
      await syncAccountFromStripe(connectAccount, result.organization.id);

      logger.info('Stripe Connect account created successfully', {
        organizationId: result.organization.id,
        stripeAccountId: connectAccount.id,
        chargesEnabled: connectAccount.charges_enabled,
      });
    } catch (connectError: any) {
      // Don't fail signup if Connect account creation fails
      // User can create it later from the app or vendor portal
      logger.error('Failed to create Stripe Connect account during signup (non-critical)', {
        error: {
          message: connectError?.message || 'Unknown error',
          code: connectError?.code,
          type: connectError?.type,
        },
        organizationId: result.organization.id,
        email: normalizedEmail,
      });
    }

    // 8. Authenticate user with Cognito to get tokens
    const tokens = await authService.login(normalizedEmail, validated.password);

    // 9. Generate appropriate URLs based on tier
    let customPlanRequested = false;
    
    if (validated.subscriptionTier === 'enterprise') {
      customPlanRequested = true;
    }

    // 10. Log audit event
    await query(
      `INSERT INTO audit_logs (
        organization_id, user_id, action, entity_type, entity_id
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        result.organization.id,
        result.user.id,
        'account.created',
        'organization',
        result.organization.id,
      ]
    );

    logger.info('New account created', {
      userId: result.user.id,
      organizationId: result.organization.id,
      email: validated.email,
    });

    // Send welcome email asynchronously
    try {
      logger.info('Attempting to queue welcome email', {
        userId: result.user.id,
        email: result.user.email,
        firstName: result.user.first_name,
        organizationName: result.organization.name,
        subscriptionTier: result.subscription.tier,
        queueServiceExists: !!queueService,
      });

      const jobData = {
        type: 'welcome' as const,
        to: result.user.email,
        data: {
          firstName: result.user.first_name,
          organizationName: result.organization.name,
          subscriptionTier: result.subscription.tier,
        },
      };

      logger.info('Email job data prepared', {
        jobData,
        queueName: QueueName.EMAIL_NOTIFICATIONS,
      });

      const job = await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, jobData, {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      });
      
      logger.info('Welcome email queued successfully', {
        userId: result.user.id,
        email: result.user.email,
        jobId: job?.id,
        jobName: job?.name,
      });
    } catch (emailError: any) {
      // Don't fail the signup if email fails - log and continue
      logger.error('Failed to queue welcome email', {
        error: {
          message: emailError?.message || 'Unknown error',
          stack: emailError?.stack,
          name: emailError?.name,
          code: emailError?.code,
          details: emailError,
        },
        userId: result.user.id,
        email: result.user.email,
        queueServiceExists: !!queueService,
      });
    }

    const response = {
      user: {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.first_name,
        lastName: result.user.last_name,
        organizationId: result.user.organization_id,
      },
      organization: {
        id: result.organization.id,
        name: result.organization.name,
      },
      subscription: {
        id: result.subscription.id,
        tier: result.subscription.tier,
        status: result.subscription.status,
        trialEndsAt: result.subscription.trial_end?.toISOString() || null,
      },
      tokens,
      ...(result.paymentIntentClientSecret && { paymentIntentClientSecret: result.paymentIntentClientSecret }),
      ...(result.stripeSubscriptionId && { stripeSubscriptionId: result.stripeSubscriptionId }),
      ...(customPlanRequested && { customPlanRequested }),
    };
    
    return c.json(response, 201);

  } catch (error: any) {
    logger.error('Signup error', { 
      error: {
        message: error.message,
        code: error.code,
        detail: error.detail,
        hint: error.hint,
        position: error.position,
        routine: error.routine,
        file: error.file,
        line: error.line,
        stack: error.stack
      },
      email: validated.email 
    });
    
    // PostgreSQL error codes
    if (error.code === '42703') {
      return c.json({ 
        error: 'DATABASE_SCHEMA_ERROR',
        message: 'The database schema is not properly set up. Please contact support.',
        details: 'Missing column: ' + (error.message.match(/column "(\w+)"/) || [])[1]
      }, 500);
    }
    
    if (error.code === '23505') {
      const detail = error.detail || '';
      if (detail.includes('email')) {
        return c.json({ 
          error: 'EMAIL_EXISTS',
          message: 'An account with this email address already exists.'
        }, 409);
      } else if (detail.includes('stripe_customer_id')) {
        return c.json({ 
          error: 'STRIPE_CUSTOMER_EXISTS',
          message: 'This Stripe customer ID is already associated with another account.'
        }, 409);
      }
      return c.json({ 
        error: 'DUPLICATE_ENTRY',
        message: 'A unique constraint was violated. Please try again.'
      }, 409);
    }
    
    if (error.message && error.message.includes('already exists')) {
      return c.json({ 
        error: 'EMAIL_EXISTS',
        message: 'An account with this email address already exists.'
      }, 409);
    }
    
    if (error.message && error.message.includes('Failed to create authentication account')) {
      return c.json({ 
        error: 'COGNITO_ERROR',
        message: 'Failed to create authentication account. Please try again later.'
      }, 500);
    }
    
    if (error.name === 'InvalidParameterException') {
      return c.json({ 
        error: 'INVALID_INPUT',
        message: error.message || 'Invalid input parameters provided.'
      }, 400);
    }
    
    return c.json({ 
      error: 'SIGNUP_FAILED',
      message: 'An unexpected error occurred during signup. Please try again.',
      ...(process.env.NODE_ENV === 'development' && { debug: error.message })
    }, 500);
  }
});

export default app;