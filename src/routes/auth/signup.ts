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

const app = new OpenAPIHono();

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
  const body = await c.req.json();
  const validated = SignupRequestSchema.parse(body);

  if (!validated.acceptTerms || !validated.acceptPrivacy) {
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

      // 5. Create subscription based on tier
      const pricing = PRICING_BY_TIER[validated.subscriptionTier];
      const features = DEFAULT_FEATURES_BY_TIER[validated.subscriptionTier];
      
      let subscriptionStatus = 'active';
      let stripeSubscriptionId = null;
      
      // For pro tier, create subscription with trial and collect payment method
      if (validated.subscriptionTier === 'pro' && config.stripe.proPriceId) {
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

      const subscriptionResult = await client.query(
        `INSERT INTO subscriptions (
          user_id, organization_id, stripe_customer_id,
          tier, status, stripe_subscription_id,
          monthly_price, transaction_fee_rate, features,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
          validated.subscriptionTier === 'pro' ? { price_id: config.stripe.proPriceId } : {},
        ]
      );
      const subscription = subscriptionResult.rows[0];

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