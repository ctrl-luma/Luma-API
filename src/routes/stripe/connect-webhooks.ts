import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { config } from '../../config';
import { stripeService } from '../../services/stripe';
import { logger } from '../../utils/logger';
import { transaction } from '../../db';

const app = new OpenAPIHono();

const connectWebhookRoute = createRoute({
  method: 'post',
  path: '/stripe/webhook-connect',
  summary: 'Handle Stripe Connect webhooks',
  tags: ['Webhooks'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.any(),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Webhook processed successfully',
      content: {
        'application/json': {
          schema: z.object({
            received: z.boolean(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid webhook signature',
    },
  },
});

app.openapi(connectWebhookRoute, async (c) => {
  const signature = c.req.header('stripe-signature');
  const rawBody = await c.req.raw.text();

  if (!signature) {
    return c.json({ error: 'Missing stripe-signature header' }, 400);
  }

  let event;
  try {
    event = stripeService.constructWebhookEvent(
      rawBody,
      signature,
      config.stripe.connectWebhookSecret || ''
    );
  } catch (error) {
    logger.error('Connect webhook signature verification failed', error);
    return c.json({ error: 'Invalid signature' }, 400);
  }

  logger.info('Connect webhook received', {
    type: event.type,
    id: event.id,
    account: event.account,
  });

  try {
    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event.data.object, event.account);
        break;

      case 'balance.available':
        await handleBalanceAvailable(event.data.object, event.account);
        break;

      case 'payout.created':
        await handleConnectPayoutCreated(event.data.object, event.account);
        break;

      case 'payout.failed':
        await handleConnectPayoutFailed(event.data.object, event.account);
        break;

      case 'transfer.created':
        await handleConnectTransferCreated(event.data.object, event.account);
        break;

      default:
        logger.info('Unhandled Connect webhook event type', { type: event.type });
    }

    return c.json({ received: true });
  } catch (error) {
    logger.error('Error processing Connect webhook', { error, eventType: event.type });
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

async function handleAccountUpdated(account: any, connectedAccountId: string | undefined) {
  await transaction(async (client) => {
    // Update organization's Stripe onboarding status
    const result = await client.query(
      `UPDATE organizations 
       SET stripe_onboarding_completed = $1,
           updated_at = NOW()
       WHERE stripe_account_id = $2
       RETURNING id, name`,
      [
        account.charges_enabled && account.payouts_enabled,
        connectedAccountId || account.id,
      ]
    );

    if (result.rows.length > 0) {
      const org = result.rows[0];
      
      await client.query(
        `INSERT INTO audit_logs (
          organization_id, action, entity_type, entity_id, changes
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          org.id,
          'connect_account.updated',
          'organization',
          org.id,
          {
            charges_enabled: account.charges_enabled,
            payouts_enabled: account.payouts_enabled,
            requirements: account.requirements,
          },
        ]
      );

      logger.info('Connected account updated', {
        accountId: connectedAccountId || account.id,
        organizationId: org.id,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
      });
    }
  });
}

async function handleBalanceAvailable(balance: any, connectedAccountId: string | undefined) {
  // Log available balance for monitoring
  const availableAmount = balance.available?.reduce((sum: number, b: any) => {
    return sum + (b.amount || 0);
  }, 0) || 0;

  logger.info('Connected account balance available', {
    accountId: connectedAccountId,
    availableAmount: availableAmount / 100,
    pending: balance.pending,
  });

  // Optionally trigger automatic payouts if balance exceeds threshold
  if (availableAmount > 10000) { // $100 threshold
    await checkAndCreateAutomaticPayout(connectedAccountId, availableAmount);
  }
}

async function handleConnectPayoutCreated(payout: any, connectedAccountId: string | undefined) {
  await transaction(async (client) => {
    // Find organization by Stripe account ID
    const orgResult = await client.query(
      `SELECT id, name FROM organizations WHERE stripe_account_id = $1`,
      [connectedAccountId]
    );

    if (orgResult.rows.length === 0) {
      logger.warn('Organization not found for payout', { 
        accountId: connectedAccountId,
        payoutId: payout.id,
      });
      return;
    }

    const org = orgResult.rows[0];

    // Record the payout
    await client.query(
      `INSERT INTO payouts (
        organization_id, stripe_payout_id, amount, status,
        type, description, created_at
      ) VALUES ($1, $2, $3, 'processing', 'connect_payout', $4, NOW())
      ON CONFLICT (stripe_payout_id) DO UPDATE
      SET status = 'processing',
          updated_at = NOW()`,
      [
        org.id,
        payout.id,
        payout.amount / 100,
        `Automatic payout to ${payout.destination}`,
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (
        organization_id, action, entity_type, entity_id, changes
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        org.id,
        'connect_payout.created',
        'payout',
        payout.id,
        {
          amount: payout.amount / 100,
          currency: payout.currency,
          arrival_date: payout.arrival_date,
          method: payout.method,
        },
      ]
    );
  });

  logger.info('Connect payout created', {
    accountId: connectedAccountId,
    payoutId: payout.id,
    amount: payout.amount / 100,
    arrivalDate: new Date(payout.arrival_date * 1000),
  });
}

async function handleConnectPayoutFailed(payout: any, connectedAccountId: string | undefined) {
  await transaction(async (client) => {
    // Update payout status to failed
    await client.query(
      `UPDATE payouts 
       SET status = 'failed',
           updated_at = NOW()
       WHERE stripe_payout_id = $1`,
      [payout.id]
    );

    // Find organization for logging
    const orgResult = await client.query(
      `SELECT id FROM organizations WHERE stripe_account_id = $1`,
      [connectedAccountId]
    );

    if (orgResult.rows.length > 0) {
      await client.query(
        `INSERT INTO audit_logs (
          organization_id, action, entity_type, entity_id, changes
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          orgResult.rows[0].id,
          'connect_payout.failed',
          'payout',
          payout.id,
          {
            failure_code: payout.failure_code,
            failure_message: payout.failure_message,
            amount: payout.amount / 100,
          },
        ]
      );
    }
  });

  logger.error('Connect payout failed', {
    accountId: connectedAccountId,
    payoutId: payout.id,
    failureCode: payout.failure_code,
    failureMessage: payout.failure_message,
  });

  // TODO: Send notification to vendor about failed payout
}

async function handleConnectTransferCreated(transfer: any, connectedAccountId: string | undefined) {
  logger.info('Connect transfer created', {
    accountId: connectedAccountId,
    transferId: transfer.id,
    amount: transfer.amount / 100,
    destination: transfer.destination,
  });

  // Transfers are typically logged when created by your platform
  // This event confirms Stripe processed it successfully
}

async function checkAndCreateAutomaticPayout(
  connectedAccountId: string | undefined,
  availableAmount: number
) {
  if (!connectedAccountId) return;

  try {
    // Check if automatic payouts are enabled for this account
    const account = await stripeService.retrieveAccount(connectedAccountId);
    
    if (account.settings?.payouts?.schedule?.interval === 'manual') {
      // Create manual payout if balance exceeds threshold
      logger.info('Creating automatic payout for high balance', {
        accountId: connectedAccountId,
        amount: availableAmount / 100,
      });
      
      // Note: Actual payout creation would happen through Stripe API
      // This is just logging the intention
    }
  } catch (error) {
    logger.error('Failed to check automatic payout', { error, accountId: connectedAccountId });
  }
}

export default app;