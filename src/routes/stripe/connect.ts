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

export default app;

// Export the sync function for use in webhooks
export { syncAccountFromStripe, deriveOnboardingState };
