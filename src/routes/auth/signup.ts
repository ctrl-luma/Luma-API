import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { authService } from '../../services/auth';
import { stripeService } from '../../services/stripe';
import { cognitoService } from '../../services/auth/cognito';
import { query, transaction } from '../../db';
import { logger } from '../../utils/logger';
import { normalizeEmail } from '../../utils/email';
import { DEFAULT_FEATURES_BY_TIER, PRICING_BY_TIER } from '../../db/models/subscription';
import { COGNITO_GROUPS, DB_ROLES, mapDbRoleToCognitoGroup } from '../../constants/auth';

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
    return c.json({ error: 'Must accept terms and privacy policy' }, 400);
  }

  const normalizedEmail = normalizeEmail(validated.email);
  
  try {
    const existingUser = await authService.getUserByEmail(normalizedEmail);
    if (existingUser) {
      return c.json({ error: 'Email already exists' }, 409);
    }

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
          terms_accepted_at, privacy_accepted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
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
        ]
      );
      const user = userResult.rows[0];

      // 4. Create Cognito user
      let cognitoUserId: string | undefined;
      if (cognitoService) {
        try {
          const cognitoUser = await cognitoService.createUser({
            email: normalizedEmail,
            temporaryPassword: validated.password,
            attributes: {
              'custom:user_id': user.id,
              'custom:organization_id': organization.id,
              'custom:role': DB_ROLES.OWNER,
              'given_name': validated.firstName,
              'family_name': validated.lastName,
              ...(validated.phone && { phone_number: validated.phone }),
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
          logger.error('Failed to create Cognito user', error);
          throw new Error('Failed to create authentication account');
        }
      }

      // 5. Create subscription
      const pricing = PRICING_BY_TIER[validated.subscriptionTier];
      const features = DEFAULT_FEATURES_BY_TIER[validated.subscriptionTier];
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + 14); // 14-day trial

      const subscriptionResult = await client.query(
        `INSERT INTO subscriptions (
          user_id, organization_id, stripe_customer_id,
          tier, status, trial_start, trial_end,
          monthly_price, transaction_fee_rate, features
        ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9)
        RETURNING *`,
        [
          user.id,
          organization.id,
          stripeCustomer.id,
          validated.subscriptionTier,
          'trialing',
          trialEnd,
          pricing.monthly_price,
          pricing.transaction_fee_rate,
          features,
        ]
      );
      const subscription = subscriptionResult.rows[0];

      // 6. Create Stripe Connect account for the organization
      const stripeAccount = await stripeService.createConnectedAccount({
        type: 'express',
        email: validated.email,
        business_type: 'company',
        metadata: {
          organization_id: organization.id,
          user_id: user.id,
        },
      });

      // Update organization with Stripe account ID
      await client.query(
        `UPDATE organizations SET stripe_account_id = $1 WHERE id = $2`,
        [stripeAccount.id, organization.id]
      );
      organization.stripe_account_id = stripeAccount.id;

      return { user, organization, subscription };
    });

    // 7. Generate auth tokens
    const tokens = await authService.generateTokens(result.user);

    // 8. Log audit event
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

    return c.json({
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
    }, 201);

  } catch (error: any) {
    logger.error('Signup error', { error, email: validated.email });
    
    if (error.message.includes('already exists')) {
      return c.json({ error: 'Email already exists' }, 409);
    }
    
    return c.json({ 
      error: 'Failed to create account',
      message: error.message 
    }, 500);
  }
});

export default app;