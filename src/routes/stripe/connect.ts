import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query, transaction } from '../../db';
import { StripeConnectedAccount, ConnectOnboardingState } from '../../db/models';
import { stripeService } from '../../services/stripe';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import Stripe from 'stripe';

const app = new OpenAPIHono();

// Helper function to derive onboarding state from Stripe account
function deriveOnboardingState(account: Stripe.Account): ConnectOnboardingState {
  if (!account.details_submitted) {
    return 'not_started';
  }

  if (account.requirements?.disabled_reason) {
    return 'disabled';
  }

  if (account.requirements?.past_due && account.requirements.past_due.length > 0) {
    return 'restricted';
  }

  if (account.charges_enabled && account.payouts_enabled) {
    if (account.requirements?.currently_due && account.requirements.currently_due.length > 0) {
      return 'pending_verification';
    }
    return 'active';
  }

  if (account.requirements?.currently_due && account.requirements.currently_due.length > 0) {
    return 'incomplete';
  }

  return 'pending_verification';
}

// Helper function to update local DB from Stripe account
async function syncAccountFromStripe(account: Stripe.Account, organizationId: string) {
  const onboardingState = deriveOnboardingState(account);
  const isComplete = onboardingState === 'active';

  // Get external account info if available
  let externalAccountLast4: string | null = null;
  let externalAccountBankName: string | null = null;
  let externalAccountType: string | null = null;

  if (account.external_accounts?.data && account.external_accounts.data.length > 0) {
    const externalAccount = account.external_accounts.data[0];
    if (externalAccount.object === 'bank_account') {
      externalAccountLast4 = externalAccount.last4 || null;
      externalAccountBankName = externalAccount.bank_name || null;
      externalAccountType = 'bank_account';
    } else if (externalAccount.object === 'card') {
      externalAccountLast4 = externalAccount.last4 || null;
      externalAccountBankName = externalAccount.brand || null;
      externalAccountType = 'card';
    }
  }

  const queryParams = [
    organizationId,
    account.id,
    account.type || 'express',
    account.charges_enabled,
    account.payouts_enabled,
    account.details_submitted,
    JSON.stringify(account.requirements?.currently_due || []),
    JSON.stringify(account.requirements?.eventually_due || []),
    JSON.stringify(account.requirements?.past_due || []),
    account.requirements?.disabled_reason || null,
    onboardingState,
    account.country || 'US',
    account.default_currency || 'usd',
    account.business_type || null,
    account.business_profile?.name || (account as any).company?.name || null,
    externalAccountLast4,
    externalAccountBankName,
    externalAccountType,
    isComplete,
  ];

  logger.info('syncAccountFromStripe query params', {
    params: queryParams.map((p, i) => ({ [`$${i + 1}`]: p, type: typeof p })),
  });

  await transaction(async (client) => {
    // Upsert the stripe_connected_accounts record
    await client.query(
      `INSERT INTO stripe_connected_accounts (
        organization_id,
        stripe_account_id,
        account_type,
        charges_enabled,
        payouts_enabled,
        details_submitted,
        requirements_currently_due,
        requirements_eventually_due,
        requirements_past_due,
        requirements_disabled_reason,
        onboarding_state,
        country,
        default_currency,
        business_type,
        business_name,
        external_account_last4,
        external_account_bank_name,
        external_account_type,
        onboarding_completed_at,
        last_stripe_sync_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, CASE WHEN $19 THEN NOW() ELSE NULL END, NOW())
      ON CONFLICT (organization_id) DO UPDATE SET
        charges_enabled = $4,
        payouts_enabled = $5,
        details_submitted = $6,
        requirements_currently_due = $7::jsonb,
        requirements_eventually_due = $8::jsonb,
        requirements_past_due = $9::jsonb,
        requirements_disabled_reason = $10,
        onboarding_state = $11,
        country = $12,
        default_currency = $13,
        business_type = $14,
        business_name = $15,
        external_account_last4 = $16,
        external_account_bank_name = $17,
        external_account_type = $18,
        onboarding_completed_at = CASE WHEN $19 AND stripe_connected_accounts.onboarding_completed_at IS NULL THEN NOW() ELSE stripe_connected_accounts.onboarding_completed_at END,
        last_stripe_sync_at = NOW(),
        updated_at = NOW()`,
      queryParams
    );

    // Also update the organization's stripe fields for backward compatibility
    await client.query(
      `UPDATE organizations SET
        stripe_account_id = $1,
        stripe_onboarding_completed = $2,
        updated_at = NOW()
      WHERE id = $3`,
      [account.id, isComplete, organizationId]
    );
  });

  return onboardingState;
}

// ============================================
// GET /stripe/connect/status - Check onboarding status
// ============================================
const getConnectStatusRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/status',
  summary: 'Get Stripe Connect onboarding status',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Connect status retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            hasConnectedAccount: z.boolean(),
            onboardingComplete: z.boolean(),
            onboardingState: z.enum(['not_started', 'incomplete', 'pending_verification', 'active', 'restricted', 'disabled']),
            chargesEnabled: z.boolean(),
            payoutsEnabled: z.boolean(),
            detailsSubmitted: z.boolean(),
            requirementsCurrentlyDue: z.array(z.string()),
            requirementsPastDue: z.array(z.string()),
            disabledReason: z.string().nullable(),
            businessName: z.string().nullable(),
            externalAccountLast4: z.string().nullable(),
            externalAccountBankName: z.string().nullable(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(getConnectStatusRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Check if we have a connected account record
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      // No connected account yet
      return c.json({
        hasConnectedAccount: false,
        onboardingComplete: false,
        onboardingState: 'not_started' as ConnectOnboardingState,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
        disabledReason: null,
        businessName: null,
        externalAccountLast4: null,
        externalAccountBankName: null,
      });
    }

    const connectedAccount = rows[0];

    // Force refresh if pending_stripe_sync flag is set (user returned from Stripe)
    // Otherwise, optionally refresh if last sync was more than 5 minutes ago
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const shouldRefresh = connectedAccount.pending_stripe_sync ||
                          !connectedAccount.last_stripe_sync_at ||
                          connectedAccount.last_stripe_sync_at < fiveMinutesAgo;

    if (shouldRefresh) {
      try {
        const stripeAccount = await stripeService.retrieveAccount(connectedAccount.stripe_account_id);
        await syncAccountFromStripe(stripeAccount, payload.organizationId);

        // Clear the pending_stripe_sync flag if it was set
        if (connectedAccount.pending_stripe_sync) {
          await query(
            'UPDATE stripe_connected_accounts SET pending_stripe_sync = FALSE WHERE organization_id = $1',
            [payload.organizationId]
          );
        }

        // Re-fetch updated data
        const updatedRows = await query<StripeConnectedAccount>(
          'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
          [payload.organizationId]
        );
        if (updatedRows.length > 0) {
          const updated = updatedRows[0];
          return c.json({
            hasConnectedAccount: true,
            onboardingComplete: updated.onboarding_state === 'active',
            onboardingState: updated.onboarding_state,
            chargesEnabled: updated.charges_enabled,
            payoutsEnabled: updated.payouts_enabled,
            detailsSubmitted: updated.details_submitted,
            requirementsCurrentlyDue: updated.requirements_currently_due,
            requirementsPastDue: updated.requirements_past_due,
            disabledReason: updated.requirements_disabled_reason,
            businessName: updated.business_name,
            externalAccountLast4: updated.external_account_last4,
            externalAccountBankName: updated.external_account_bank_name,
          });
        }
      } catch (error) {
        logger.warn('Failed to refresh Stripe account status', { error, accountId: connectedAccount.stripe_account_id });
      }
    }

    return c.json({
      hasConnectedAccount: true,
      onboardingComplete: connectedAccount.onboarding_state === 'active',
      onboardingState: connectedAccount.onboarding_state,
      chargesEnabled: connectedAccount.charges_enabled,
      payoutsEnabled: connectedAccount.payouts_enabled,
      detailsSubmitted: connectedAccount.details_submitted,
      requirementsCurrentlyDue: connectedAccount.requirements_currently_due,
      requirementsPastDue: connectedAccount.requirements_past_due,
      disabledReason: connectedAccount.requirements_disabled_reason,
      businessName: connectedAccount.business_name,
      externalAccountLast4: connectedAccount.external_account_last4,
      externalAccountBankName: connectedAccount.external_account_bank_name,
    });
  } catch (error) {
    logger.error('Error getting connect status', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to get connect status' }, 500);
  }
});

// ============================================
// POST /stripe/connect/create-account - Create a new connected account
// ============================================
const createConnectedAccountRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/create-account',
  summary: 'Create a new Stripe Connect account and start onboarding',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            country: z.string().length(2).optional().default('US'),
            businessType: z.enum(['individual', 'company']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Account created and onboarding link generated',
      content: {
        'application/json': {
          schema: z.object({
            accountId: z.string(),
            onboardingUrl: z.string(),
          }),
        },
      },
    },
    400: { description: 'Account already exists' },
    401: { description: 'Unauthorized' },
    403: { description: 'Only owners can create connected accounts' },
  },
});

app.openapi(createConnectedAccountRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Only owners can create connected accounts
    if (payload.role !== 'owner') {
      return c.json({ error: 'Only organization owners can set up payment accounts' }, 403);
    }

    // Check if account already exists
    const existingRows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (existingRows.length > 0) {
      // Account exists, just generate a new onboarding link
      const existingAccount = existingRows[0];
      const accountLink = await stripeService.createAccountLink(
        existingAccount.stripe_account_id,
        `${config.email.dashboardUrl}/connect`,
        `${config.email.dashboardUrl}/connect`
      );

      // Set flag so next status check will force refresh from Stripe
      await query(
        'UPDATE stripe_connected_accounts SET pending_stripe_sync = TRUE WHERE organization_id = $1',
        [payload.organizationId]
      );

      return c.json({
        accountId: existingAccount.stripe_account_id,
        onboardingUrl: accountLink.url,
      });
    }

    const body = await c.req.json();

    // Get user email for the connected account
    const userRows = await query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [payload.userId]
    );

    if (userRows.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Create new Stripe connected account
    const account = await stripeService.createConnectedAccount({
      type: 'express',
      country: body.country || 'US',
      email: userRows[0].email,
      business_type: body.businessType,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        organization_id: payload.organizationId,
        user_id: payload.userId,
      },
    });

    // Sync the new account to our database
    await syncAccountFromStripe(account, payload.organizationId);

    // Create onboarding link
    const accountLink = await stripeService.createAccountLink(
      account.id,
      `${config.email.dashboardUrl}/connect`,
      `${config.email.dashboardUrl}/connect`
    );

    // Set flag so next status check will force refresh from Stripe
    await query(
      'UPDATE stripe_connected_accounts SET pending_stripe_sync = TRUE WHERE organization_id = $1',
      [payload.organizationId]
    );

    logger.info('Created new connected account', {
      accountId: account.id,
      organizationId: payload.organizationId,
      userId: payload.userId,
    });

    return c.json({
      accountId: account.id,
      onboardingUrl: accountLink.url,
    });
  } catch (error) {
    logger.error('Error creating connected account', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to create connected account' }, 500);
  }
});

// ============================================
// POST /stripe/connect/onboarding-link - Generate a new onboarding link
// ============================================
const createOnboardingLinkRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/onboarding-link',
  summary: 'Generate a new Stripe Connect onboarding link',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Onboarding link generated',
      content: {
        'application/json': {
          schema: z.object({
            onboardingUrl: z.string(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(createOnboardingLinkRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get existing connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found. Create one first.' }, 404);
    }

    const connectedAccount = rows[0];

    // Create onboarding link (can be for onboarding or updating info)
    const linkType = connectedAccount.onboarding_state === 'active' ? 'account_update' : 'account_onboarding';

    const accountLink = await stripeService.createAccountLink(
      connectedAccount.stripe_account_id,
      `${config.email.dashboardUrl}/connect`,
      `${config.email.dashboardUrl}/connect`
    );

    // Set flag so next status check will force refresh from Stripe
    await query(
      'UPDATE stripe_connected_accounts SET pending_stripe_sync = TRUE WHERE organization_id = $1',
      [payload.organizationId]
    );

    logger.info('Generated onboarding link', {
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      linkType,
    });

    return c.json({
      onboardingUrl: accountLink.url,
    });
  } catch (error) {
    logger.error('Error creating onboarding link', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to create onboarding link' }, 500);
  }
});

// ============================================
// POST /stripe/connect/refresh-status - Manually refresh status from Stripe
// ============================================
const refreshStatusRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/refresh-status',
  summary: 'Manually refresh connected account status from Stripe',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Status refreshed successfully',
      content: {
        'application/json': {
          schema: z.object({
            onboardingState: z.enum(['not_started', 'incomplete', 'pending_verification', 'active', 'restricted', 'disabled']),
            chargesEnabled: z.boolean(),
            payoutsEnabled: z.boolean(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(refreshStatusRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get existing connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    // Fetch fresh data from Stripe
    const stripeAccount = await stripeService.retrieveAccount(connectedAccount.stripe_account_id);
    const onboardingState = await syncAccountFromStripe(stripeAccount, payload.organizationId);

    logger.info('Refreshed connected account status', {
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      newState: onboardingState,
    });

    return c.json({
      onboardingState,
      chargesEnabled: stripeAccount.charges_enabled,
      payoutsEnabled: stripeAccount.payouts_enabled,
    });
  } catch (error) {
    logger.error('Error refreshing status', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to refresh status' }, 500);
  }
});

// ============================================
// GET /stripe/connect/balance - Get connected account balance
// ============================================
const getBalanceRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/balance',
  summary: 'Get Stripe Connect account balance',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Balance retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            available: z.array(z.object({
              amount: z.number(),
              currency: z.string(),
            })),
            pending: z.array(z.object({
              amount: z.number(),
              currency: z.string(),
            })),
            instantAvailable: z.array(z.object({
              amount: z.number(),
              currency: z.string(),
            })).optional(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
    403: { description: 'Payouts not enabled for this account' },
  },
});

app.openapi(getBalanceRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    if (!connectedAccount.payouts_enabled) {
      return c.json({ error: 'Payouts are not enabled for this account' }, 403);
    }

    // Get balance from Stripe
    const balance = await stripeService.getConnectedAccountBalance(connectedAccount.stripe_account_id);

    // Convert amounts from cents to dollars
    const formatBalance = (balanceItems: Array<{ amount: number; currency: string }>) =>
      balanceItems.map((item) => ({
        amount: item.amount / 100,
        currency: item.currency,
      }));

    logger.info('Retrieved connected account balance', {
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
    });

    return c.json({
      available: formatBalance(balance.available),
      pending: formatBalance(balance.pending),
      instantAvailable: balance.instant_available ? formatBalance(balance.instant_available) : undefined,
    });
  } catch (error) {
    logger.error('Error getting balance', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to get balance' }, 500);
  }
});

// ============================================
// GET /stripe/connect/payouts - List payouts for connected account
// ============================================
const listPayoutsRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/payouts',
  summary: 'List payouts for connected account',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.enum(['pending', 'paid', 'failed', 'canceled']).optional(),
      limit: z.string().transform(Number).optional(),
      starting_after: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Payouts retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(z.object({
              id: z.string(),
              amount: z.number(),
              currency: z.string(),
              status: z.string(),
              method: z.string(),
              arrivalDate: z.number(),
              created: z.number(),
              description: z.string().nullable(),
              failureCode: z.string().nullable(),
              failureMessage: z.string().nullable(),
              automatic: z.boolean(),
              destination: z.object({
                last4: z.string().nullable(),
                bankName: z.string().nullable(),
                type: z.string(),
              }).nullable(),
            })),
            hasMore: z.boolean(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(listPayoutsRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];
    const queryParams = c.req.query();

    // Get payouts from Stripe
    const payouts = await stripeService.listConnectedAccountPayouts(
      connectedAccount.stripe_account_id,
      {
        status: queryParams.status as any,
        limit: queryParams.limit ? parseInt(queryParams.limit) : 10,
        starting_after: queryParams.starting_after,
      }
    );

    // Format the response
    const formattedPayouts = payouts.data.map((payout) => {
      let destination = null;
      if (payout.destination && typeof payout.destination === 'object') {
        const dest = payout.destination as any;
        destination = {
          last4: dest.last4 || null,
          bankName: dest.bank_name || dest.brand || null,
          type: dest.object || 'unknown',
        };
      }

      return {
        id: payout.id,
        amount: payout.amount / 100, // Convert from cents
        currency: payout.currency,
        status: payout.status,
        method: payout.method || 'standard',
        arrivalDate: payout.arrival_date,
        created: payout.created,
        description: payout.description,
        failureCode: payout.failure_code,
        failureMessage: payout.failure_message,
        automatic: payout.automatic ?? true,
        destination,
      };
    });

    logger.info('Retrieved connected account payouts', {
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      count: formattedPayouts.length,
    });

    return c.json({
      data: formattedPayouts,
      hasMore: payouts.has_more,
    });
  } catch (error) {
    logger.error('Error listing payouts', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to list payouts' }, 500);
  }
});

// ============================================
// POST /stripe/connect/payouts - Create a new payout
// ============================================
const createPayoutRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/payouts',
  summary: 'Create a new payout for connected account',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive().optional(), // If not provided, payout full available balance
            method: z.enum(['standard', 'instant']).optional().default('standard'),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Payout created successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            amount: z.number(),
            currency: z.string(),
            status: z.string(),
            method: z.string(),
            arrivalDate: z.number(),
            created: z.number(),
            fee: z.number().optional(),
          }),
        },
      },
    },
    400: { description: 'Bad request (e.g., insufficient balance)' },
    401: { description: 'Unauthorized' },
    403: { description: 'Payouts not enabled for this account' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(createPayoutRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    if (!connectedAccount.payouts_enabled) {
      return c.json({ error: 'Payouts are not enabled for this account' }, 403);
    }

    const body = await c.req.json();

    // Get current balance to validate
    const balance = await stripeService.getConnectedAccountBalance(connectedAccount.stripe_account_id);
    const availableUSD = balance.available.find((b) => b.currency === 'usd');
    const availableAmount = availableUSD ? availableUSD.amount / 100 : 0;

    // Determine payout amount
    let payoutAmount = body.amount || availableAmount;

    if (payoutAmount <= 0) {
      return c.json({ error: 'No available balance to payout' }, 400);
    }

    if (payoutAmount > availableAmount) {
      return c.json({
        error: `Insufficient balance. Available: $${availableAmount.toFixed(2)}, Requested: $${payoutAmount.toFixed(2)}`
      }, 400);
    }

    // For instant payouts, check if instant balance is available
    if (body.method === 'instant') {
      const instantAvailable = balance.instant_available?.find((b) => b.currency === 'usd');
      const instantAmount = instantAvailable ? instantAvailable.amount / 100 : 0;

      if (payoutAmount > instantAmount) {
        return c.json({
          error: `Insufficient instant payout balance. Available for instant: $${instantAmount.toFixed(2)}`
        }, 400);
      }
    }

    // Create the payout
    const payout = await stripeService.createConnectedAccountPayout(
      connectedAccount.stripe_account_id,
      {
        amount: payoutAmount,
        currency: 'usd',
        method: body.method || 'standard',
        description: body.description || `Manual payout - ${new Date().toLocaleDateString()}`,
        metadata: {
          organization_id: payload.organizationId,
          user_id: payload.userId,
          initiated_by: 'dashboard',
        },
      }
    );

    // Record the payout in our database
    await query(
      `INSERT INTO payouts (
        organization_id, stripe_payout_id, amount, status, type, description, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        payload.organizationId,
        payout.id,
        payoutAmount,
        payout.status === 'in_transit' ? 'processing' : payout.status,
        'manual_payout',
        body.description || 'Manual payout from dashboard',
      ]
    );

    logger.info('Created payout', {
      payoutId: payout.id,
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      amount: payoutAmount,
      method: body.method || 'standard',
    });

    // Calculate estimated fee for instant payouts (typically 1%)
    const fee = body.method === 'instant' ? payoutAmount * 0.01 : 0;

    return c.json({
      id: payout.id,
      amount: payout.amount / 100,
      currency: payout.currency,
      status: payout.status,
      method: payout.method || 'standard',
      arrivalDate: payout.arrival_date,
      created: payout.created,
      fee: fee > 0 ? fee : undefined,
    });
  } catch (error: any) {
    logger.error('Error creating payout', { error });

    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Handle Stripe-specific errors
    if (error.type === 'StripeInvalidRequestError') {
      return c.json({ error: error.message || 'Invalid payout request' }, 400);
    }

    return c.json({ error: 'Failed to create payout' }, 500);
  }
});

// ============================================
// GET /stripe/connect/transactions - List transactions for connected account
// ============================================
const listTransactionsRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/transactions',
  summary: 'List transactions (charges) for connected account',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.string().transform(Number).optional(),
      starting_after: z.string().optional(),
      ending_before: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Transactions retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(z.object({
              id: z.string(),
              amount: z.number(),
              amountRefunded: z.number(),
              currency: z.string(),
              status: z.enum(['succeeded', 'pending', 'failed', 'refunded', 'partially_refunded']),
              description: z.string().nullable(),
              customerEmail: z.string().nullable(),
              customerName: z.string().nullable(),
              paymentMethod: z.object({
                type: z.string(),
                brand: z.string().nullable(),
                last4: z.string().nullable(),
              }).nullable(),
              receiptUrl: z.string().nullable(),
              created: z.number(),
              metadata: z.record(z.string()).optional(),
            })),
            hasMore: z.boolean(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(listTransactionsRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];
    const queryParams = c.req.query();

    // Get charges from Stripe
    const charges = await stripeService.listConnectedAccountCharges(
      connectedAccount.stripe_account_id,
      {
        limit: queryParams.limit ? parseInt(queryParams.limit) : 25,
        starting_after: queryParams.starting_after,
        ending_before: queryParams.ending_before,
      }
    );

    // Format the response
    const formattedTransactions = charges.data.map((charge) => {
      // Determine status
      let status: 'succeeded' | 'pending' | 'failed' | 'refunded' | 'partially_refunded' = 'pending';
      if (charge.status === 'succeeded') {
        if (charge.refunded) {
          status = 'refunded';
        } else if (charge.amount_refunded > 0) {
          status = 'partially_refunded';
        } else {
          status = 'succeeded';
        }
      } else if (charge.status === 'failed') {
        status = 'failed';
      }

      // Get payment method details
      let paymentMethod = null;
      if (charge.payment_method_details) {
        const pm = charge.payment_method_details;
        if (pm.card) {
          paymentMethod = {
            type: 'card',
            brand: pm.card.brand,
            last4: pm.card.last4,
          };
        } else if (pm.type) {
          paymentMethod = {
            type: pm.type,
            brand: null,
            last4: null,
          };
        }
      }

      return {
        id: charge.id,
        amount: charge.amount / 100,
        amountRefunded: charge.amount_refunded / 100,
        currency: charge.currency,
        status,
        description: charge.description,
        customerEmail: charge.billing_details?.email || charge.receipt_email || null,
        customerName: charge.billing_details?.name || null,
        paymentMethod,
        receiptUrl: charge.receipt_url,
        created: charge.created,
        metadata: charge.metadata,
      };
    });

    logger.info('Retrieved connected account transactions', {
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      count: formattedTransactions.length,
    });

    return c.json({
      data: formattedTransactions,
      hasMore: charges.has_more,
    });
  } catch (error) {
    logger.error('Error listing transactions', { error });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to list transactions' }, 500);
  }
});

// ============================================
// GET /stripe/connect/transactions/:id - Get a single transaction
// ============================================
const getTransactionRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/transactions/{transactionId}',
  summary: 'Get a single transaction by ID',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      transactionId: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Transaction retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            amount: z.number(),
            amountRefunded: z.number(),
            currency: z.string(),
            status: z.string(),
            description: z.string().nullable(),
            customerEmail: z.string().nullable(),
            customerName: z.string().nullable(),
            billingAddress: z.object({
              line1: z.string().nullable(),
              line2: z.string().nullable(),
              city: z.string().nullable(),
              state: z.string().nullable(),
              postalCode: z.string().nullable(),
              country: z.string().nullable(),
            }).nullable(),
            paymentMethod: z.object({
              type: z.string(),
              brand: z.string().nullable(),
              last4: z.string().nullable(),
            }).nullable(),
            receiptUrl: z.string().nullable(),
            created: z.number(),
            metadata: z.record(z.string()).optional(),
            refunds: z.array(z.object({
              id: z.string(),
              amount: z.number(),
              status: z.string(),
              reason: z.string().nullable(),
              created: z.number(),
            })),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Transaction not found' },
  },
});

app.openapi(getTransactionRoute, async (c) => {
  const { transactionId } = c.req.param();
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    // Get charge from Stripe
    const charge = await stripeService.retrieveConnectedAccountCharge(
      connectedAccount.stripe_account_id,
      transactionId
    );

    // Determine status
    let status: string = charge.status;
    if (charge.status === 'succeeded') {
      if (charge.refunded) {
        status = 'refunded';
      } else if (charge.amount_refunded > 0) {
        status = 'partially_refunded';
      }
    }

    // Get payment method details
    let paymentMethod = null;
    if (charge.payment_method_details) {
      const pm = charge.payment_method_details;
      if (pm.card) {
        paymentMethod = {
          type: 'card',
          brand: pm.card.brand,
          last4: pm.card.last4,
        };
      } else if (pm.type) {
        paymentMethod = {
          type: pm.type,
          brand: null,
          last4: null,
        };
      }
    }

    // Get billing address
    let billingAddress = null;
    if (charge.billing_details?.address) {
      const addr = charge.billing_details.address;
      billingAddress = {
        line1: addr.line1,
        line2: addr.line2,
        city: addr.city,
        state: addr.state,
        postalCode: addr.postal_code,
        country: addr.country,
      };
    }

    // Format refunds
    const refunds = (charge.refunds?.data || []).map((refund) => ({
      id: refund.id,
      amount: refund.amount / 100,
      status: refund.status || 'unknown',
      reason: refund.reason,
      created: refund.created,
    }));

    return c.json({
      id: charge.id,
      amount: charge.amount / 100,
      amountRefunded: charge.amount_refunded / 100,
      currency: charge.currency,
      status,
      description: charge.description,
      customerEmail: charge.billing_details?.email || charge.receipt_email || null,
      customerName: charge.billing_details?.name || null,
      billingAddress,
      paymentMethod,
      receiptUrl: charge.receipt_url,
      created: charge.created,
      metadata: charge.metadata,
      refunds,
    });
  } catch (error: any) {
    logger.error('Error getting transaction', { error, transactionId });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      return c.json({ error: 'Transaction not found' }, 404);
    }
    return c.json({ error: 'Failed to get transaction' }, 500);
  }
});

// ============================================
// POST /stripe/connect/transactions/:id/refund - Refund a transaction
// ============================================
const refundTransactionRoute = createRoute({
  method: 'post',
  path: '/stripe/connect/transactions/{transactionId}/refund',
  summary: 'Refund a transaction (full or partial)',
  tags: ['Stripe Connect'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      transactionId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive().optional(), // If not provided, full refund
            reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Refund created successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            amount: z.number(),
            status: z.string(),
            reason: z.string().nullable(),
            created: z.number(),
          }),
        },
      },
    },
    400: { description: 'Bad request (e.g., already refunded)' },
    401: { description: 'Unauthorized' },
    403: { description: 'Only owners can issue refunds' },
    404: { description: 'Transaction not found' },
  },
});

app.openapi(refundTransactionRoute, async (c) => {
  const { transactionId } = c.req.param();
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Only owners can issue refunds
    if (payload.role !== 'owner') {
      return c.json({ error: 'Only organization owners can issue refunds' }, 403);
    }

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];
    const body = await c.req.json();

    // Create refund
    const refund = await stripeService.createConnectedAccountRefund(
      connectedAccount.stripe_account_id,
      {
        charge: transactionId,
        amount: body.amount,
        reason: body.reason,
        metadata: {
          organization_id: payload.organizationId,
          user_id: payload.userId,
          initiated_by: 'dashboard',
        },
      }
    );

    logger.info('Created refund', {
      refundId: refund.id,
      chargeId: transactionId,
      amount: refund.amount / 100,
      organizationId: payload.organizationId,
    });

    return c.json({
      id: refund.id,
      amount: refund.amount / 100,
      status: refund.status || 'succeeded',
      reason: refund.reason,
      created: refund.created,
    });
  } catch (error: any) {
    logger.error('Error creating refund', { error, transactionId });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      return c.json({ error: error.message || 'Invalid refund request' }, 400);
    }
    return c.json({ error: 'Failed to create refund' }, 500);
  }
});

// Dashboard metrics endpoint
const dashboardRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/dashboard',
  tags: ['Stripe Connect'],
  summary: 'Get dashboard metrics',
  description: 'Returns aggregated metrics for the vendor dashboard including sales, orders, and balance',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Dashboard metrics',
      content: {
        'application/json': {
          schema: z.object({
            today: z.object({
              sales: z.number(),
              orders: z.number(),
              averageOrderValue: z.number(),
            }),
            yesterday: z.object({
              sales: z.number(),
              orders: z.number(),
            }),
            balance: z.object({
              available: z.number(),
              pending: z.number(),
              currency: z.string(),
            }),
            recentTransactions: z.array(z.object({
              id: z.string(),
              amount: z.number(),
              currency: z.string(),
              status: z.string(),
              customerName: z.string().nullable(),
              customerEmail: z.string().nullable(),
              created: z.number(),
            })),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
    500: { description: 'Internal server error' },
  },
});

app.openapi(dashboardRoute, async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.substring(7);
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      `SELECT * FROM stripe_connected_accounts WHERE organization_id = $1`,
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];

    // Calculate time boundaries
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

    const todayStartTimestamp = Math.floor(todayStart.getTime() / 1000);
    const yesterdayStartTimestamp = Math.floor(yesterdayStart.getTime() / 1000);

    // Fetch today's charges
    const todayCharges = await stripeService.listConnectedAccountCharges(
      connectedAccount.stripe_account_id,
      {
        limit: 100,
        created: {
          gte: todayStartTimestamp,
        },
      }
    );

    // Fetch yesterday's charges
    const yesterdayCharges = await stripeService.listConnectedAccountCharges(
      connectedAccount.stripe_account_id,
      {
        limit: 100,
        created: {
          gte: yesterdayStartTimestamp,
          lte: todayStartTimestamp - 1,
        },
      }
    );

    // Fetch balance
    const balance = await stripeService.getConnectedAccountBalance(
      connectedAccount.stripe_account_id
    );

    // Fetch recent transactions (last 5)
    const recentCharges = await stripeService.listConnectedAccountCharges(
      connectedAccount.stripe_account_id,
      { limit: 5 }
    );

    // Calculate today's metrics (only succeeded charges)
    const todaySucceeded = todayCharges.data.filter(c => c.status === 'succeeded');
    const todaySales = todaySucceeded.reduce((sum, c) => sum + (c.amount - (c.amount_refunded || 0)), 0) / 100;
    const todayOrders = todaySucceeded.length;
    const todayAvgOrder = todayOrders > 0 ? todaySales / todayOrders : 0;

    // Calculate yesterday's metrics (only succeeded charges)
    const yesterdaySucceeded = yesterdayCharges.data.filter(c => c.status === 'succeeded');
    const yesterdaySales = yesterdaySucceeded.reduce((sum, c) => sum + (c.amount - (c.amount_refunded || 0)), 0) / 100;
    const yesterdayOrders = yesterdaySucceeded.length;

    // Get balance amounts (default to USD) - handle empty arrays
    const availableBalance = balance.available?.length > 0
      ? (balance.available.find(b => b.currency === 'usd') || balance.available[0])
      : null;
    const pendingBalance = balance.pending?.length > 0
      ? (balance.pending.find(b => b.currency === 'usd') || balance.pending[0])
      : null;

    // Format recent transactions
    const recentTransactions = recentCharges.data.map(charge => ({
      id: charge.id,
      amount: charge.amount / 100,
      currency: charge.currency,
      status: charge.status,
      customerName: charge.billing_details?.name || null,
      customerEmail: charge.billing_details?.email || charge.receipt_email || null,
      created: charge.created,
    }));

    return c.json({
      today: {
        sales: todaySales,
        orders: todayOrders,
        averageOrderValue: Math.round(todayAvgOrder * 100) / 100,
      },
      yesterday: {
        sales: yesterdaySales,
        orders: yesterdayOrders,
      },
      balance: {
        available: availableBalance ? availableBalance.amount / 100 : 0,
        pending: pendingBalance ? pendingBalance.amount / 100 : 0,
        currency: availableBalance?.currency || pendingBalance?.currency || 'usd',
      },
      recentTransactions,
    });
  } catch (error: any) {
    logger.error('Error fetching dashboard metrics', {
      error: error.message || error,
      stack: error.stack,
      type: error.type,
      code: error.code,
    });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to fetch dashboard metrics', details: error.message }, 500);
  }
});

// Analytics endpoint
const analyticsRoute = createRoute({
  method: 'get',
  path: '/stripe/connect/analytics',
  tags: ['Stripe Connect'],
  summary: 'Get analytics data',
  description: 'Returns analytics data for the specified time range',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      range: z.enum(['today', 'week', 'month', 'all']).default('week'),
    }),
  },
  responses: {
    200: {
      description: 'Analytics data',
      content: {
        'application/json': {
          schema: z.object({
            metrics: z.object({
              revenue: z.number(),
              transactions: z.number(),
              averageTransaction: z.number(),
              previousRevenue: z.number(),
              previousTransactions: z.number(),
            }),
            revenueData: z.array(z.object({
              label: z.string(),
              revenue: z.number(),
            })),
            paymentMethods: z.array(z.object({
              method: z.string(),
              percentage: z.number(),
              count: z.number(),
            })),
            peakHours: z.array(z.object({
              hour: z.string(),
              count: z.number(),
            })),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'No connected account found' },
    500: { description: 'Internal server error' },
  },
});

app.openapi(analyticsRoute, async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.substring(7);
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    // Get connected account
    const rows = await query<StripeConnectedAccount>(
      `SELECT * FROM stripe_connected_accounts WHERE organization_id = $1`,
      [payload.organizationId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'No connected account found' }, 404);
    }

    const connectedAccount = rows[0];
    const range = c.req.query('range') || 'week';

    // Calculate time boundaries based on range
    const now = new Date();
    let currentStart: Date;
    let previousStart: Date;
    let previousEnd: Date;

    switch (range) {
      case 'today':
        currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        previousStart = new Date(currentStart.getTime() - 24 * 60 * 60 * 1000);
        previousEnd = new Date(currentStart.getTime() - 1);
        break;
      case 'week':
        currentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
        previousEnd = new Date(currentStart.getTime() - 1);
        break;
      case 'month':
        currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
        previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        previousEnd = new Date(currentStart.getTime() - 1);
        break;
      case 'all':
      default:
        // Last 6 months
        currentStart = new Date(now.getFullYear(), now.getMonth() - 6, 1);
        previousStart = new Date(now.getFullYear(), now.getMonth() - 12, 1);
        previousEnd = new Date(currentStart.getTime() - 1);
        break;
    }

    const currentStartTimestamp = Math.floor(currentStart.getTime() / 1000);
    const previousStartTimestamp = Math.floor(previousStart.getTime() / 1000);
    const previousEndTimestamp = Math.floor(previousEnd.getTime() / 1000);

    // Fetch current period charges (get up to 100 for analytics)
    const currentCharges = await stripeService.listConnectedAccountCharges(
      connectedAccount.stripe_account_id,
      {
        limit: 100,
        created: { gte: currentStartTimestamp },
      }
    );

    // Fetch previous period charges for comparison
    const previousCharges = await stripeService.listConnectedAccountCharges(
      connectedAccount.stripe_account_id,
      {
        limit: 100,
        created: { gte: previousStartTimestamp, lte: previousEndTimestamp },
      }
    );

    // Calculate current period metrics (only succeeded charges)
    const currentSucceeded = currentCharges.data.filter(c => c.status === 'succeeded');
    const currentRevenue = currentSucceeded.reduce((sum, c) => sum + (c.amount - (c.amount_refunded || 0)), 0) / 100;
    const currentTransactions = currentSucceeded.length;
    const currentAvgTransaction = currentTransactions > 0 ? currentRevenue / currentTransactions : 0;

    // Calculate previous period metrics
    const previousSucceeded = previousCharges.data.filter(c => c.status === 'succeeded');
    const previousRevenue = previousSucceeded.reduce((sum, c) => sum + (c.amount - (c.amount_refunded || 0)), 0) / 100;
    const previousTransactions = previousSucceeded.length;

    // Calculate revenue data by time period
    const revenueData: Array<{ label: string; revenue: number }> = [];

    if (range === 'today') {
      // Group by hour
      const hourlyData: Record<number, number> = {};
      for (let h = 0; h < 24; h++) {
        hourlyData[h] = 0;
      }
      currentSucceeded.forEach(charge => {
        const chargeDate = new Date(charge.created * 1000);
        const hour = chargeDate.getHours();
        hourlyData[hour] += (charge.amount - (charge.amount_refunded || 0)) / 100;
      });
      // Only show hours from 9 AM to 9 PM for readability
      for (let h = 9; h <= 21; h++) {
        const hour12 = h > 12 ? h - 12 : h;
        const ampm = h >= 12 ? 'PM' : 'AM';
        revenueData.push({ label: `${hour12}${ampm}`, revenue: Math.round(hourlyData[h]) });
      }
    } else if (range === 'week') {
      // Group by day of week
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dailyData: Record<number, number> = {};
      for (let d = 0; d < 7; d++) {
        dailyData[d] = 0;
      }
      currentSucceeded.forEach(charge => {
        const chargeDate = new Date(charge.created * 1000);
        const dayOfWeek = chargeDate.getDay();
        dailyData[dayOfWeek] += (charge.amount - (charge.amount_refunded || 0)) / 100;
      });
      // Start from Monday
      const orderedDays = [1, 2, 3, 4, 5, 6, 0]; // Mon to Sun
      orderedDays.forEach(d => {
        revenueData.push({ label: days[d], revenue: Math.round(dailyData[d]) });
      });
    } else if (range === 'month') {
      // Group by week
      const weeklyData: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      currentSucceeded.forEach(charge => {
        const chargeDate = new Date(charge.created * 1000);
        const dayOfMonth = chargeDate.getDate();
        const week = Math.ceil(dayOfMonth / 7);
        weeklyData[week] = (weeklyData[week] || 0) + (charge.amount - (charge.amount_refunded || 0)) / 100;
      });
      for (let w = 1; w <= 4; w++) {
        revenueData.push({ label: `Week ${w}`, revenue: Math.round(weeklyData[w] || 0) });
      }
    } else {
      // Group by month
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthlyData: Record<number, number> = {};
      currentSucceeded.forEach(charge => {
        const chargeDate = new Date(charge.created * 1000);
        const month = chargeDate.getMonth();
        monthlyData[month] = (monthlyData[month] || 0) + (charge.amount - (charge.amount_refunded || 0)) / 100;
      });
      // Show last 6 months
      for (let i = 5; i >= 0; i--) {
        const monthIndex = (now.getMonth() - i + 12) % 12;
        revenueData.push({ label: months[monthIndex], revenue: Math.round(monthlyData[monthIndex] || 0) });
      }
    }

    // Calculate payment method breakdown
    const paymentMethodCounts: Record<string, number> = {};
    currentSucceeded.forEach(charge => {
      const method = charge.payment_method_details?.type || 'other';
      let displayMethod = 'Other';
      if (method === 'card') {
        const brand = charge.payment_method_details?.card?.brand || 'card';
        displayMethod = brand.charAt(0).toUpperCase() + brand.slice(1);
      } else if (method === 'card_present') {
        displayMethod = 'Card (In-Person)';
      } else {
        displayMethod = method.charAt(0).toUpperCase() + method.slice(1).replace(/_/g, ' ');
      }
      paymentMethodCounts[displayMethod] = (paymentMethodCounts[displayMethod] || 0) + 1;
    });

    const totalPaymentMethods = Object.values(paymentMethodCounts).reduce((a, b) => a + b, 0);
    const paymentMethods = Object.entries(paymentMethodCounts)
      .map(([method, count]) => ({
        method,
        count,
        percentage: totalPaymentMethods > 0 ? Math.round((count / totalPaymentMethods) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Calculate peak hours (based on current period data)
    const hourCounts: Record<number, number> = {};
    for (let h = 0; h < 24; h++) {
      hourCounts[h] = 0;
    }
    currentSucceeded.forEach(charge => {
      const chargeDate = new Date(charge.created * 1000);
      const hour = chargeDate.getHours();
      hourCounts[hour]++;
    });

    const maxHourCount = Math.max(...Object.values(hourCounts), 1);
    const peakHours: Array<{ hour: string; count: number }> = [];
    // Show hours 9 AM to 9 PM
    for (let h = 9; h <= 21; h++) {
      const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      const ampm = h >= 12 ? 'PM' : 'AM';
      peakHours.push({
        hour: `${hour12} ${ampm}`,
        count: Math.round((hourCounts[h] / maxHourCount) * 100),
      });
    }

    return c.json({
      metrics: {
        revenue: Math.round(currentRevenue * 100) / 100,
        transactions: currentTransactions,
        averageTransaction: Math.round(currentAvgTransaction * 100) / 100,
        previousRevenue: Math.round(previousRevenue * 100) / 100,
        previousTransactions,
      },
      revenueData,
      paymentMethods,
      peakHours,
    });
  } catch (error: any) {
    logger.error('Error fetching analytics', {
      error: error.message || error,
      stack: error.stack,
    });
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'Failed to fetch analytics', details: error.message }, 500);
  }
});

export default app;

// Export the sync function for use in webhooks
export { syncAccountFromStripe, deriveOnboardingState };
