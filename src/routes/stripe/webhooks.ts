import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { config } from '../../config';
import { stripeService, stripe } from '../../services/stripe';
import { logger } from '../../utils/logger';
import { query, transaction } from '../../db';
import { normalizeEmail } from '../../utils/email';
import { PRICING_BY_TIER, DEFAULT_FEATURES_BY_TIER } from '../../db/models/subscription';

const app = new OpenAPIHono();

const webhookRoute = createRoute({
  method: 'post',
  path: '/stripe/webhook',
  summary: 'Handle Stripe webhooks',
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

app.openapi(webhookRoute, async (c) => {
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
      config.stripe.webhookSecret
    );
  } catch (error) {
    logger.error('Webhook signature verification failed', error);
    return c.json({ error: 'Invalid signature' }, 400);
  }

  logger.info('Webhook received', {
    type: event.type,
    id: event.id,
  });

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event.data.object);
        break;

      case 'charge.refunded':
        await handleChargeRefunded(event.data.object);
        break;

      case 'account.updated':
        await handleAccountUpdated(event.data.object);
        break;

      case 'account.application.authorized':
        await handleAccountAuthorized(event.data.object);
        break;

      case 'transfer.created':
        await handleTransferCreated(event.data.object);
        break;

      case 'payout.created':
        await handlePayoutCreated(event.data.object);
        break;

      case 'payout.paid':
        await handlePayoutPaid(event.data.object);
        break;

      case 'payout.failed':
        await handlePayoutFailed(event.data.object);
        break;

      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;

      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object);
        break;

      default:
        logger.info('Unhandled webhook event type', { type: event.type });
    }

    return c.json({ received: true });
  } catch (error) {
    logger.error('Error processing webhook', { error, eventType: event.type });
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

async function handlePaymentIntentSucceeded(paymentIntent: any) {
  await transaction(async (client) => {
    await client.query(
      `UPDATE orders 
       SET status = 'completed', 
           stripe_charge_id = $1,
           updated_at = NOW()
       WHERE stripe_payment_intent_id = $2`,
      [paymentIntent.latest_charge, paymentIntent.id]
    );

    logger.info('Payment intent succeeded', {
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount / 100,
    });
  });
}

async function handlePaymentIntentFailed(paymentIntent: any) {
  await transaction(async (client) => {
    await client.query(
      `UPDATE orders 
       SET status = 'failed',
           updated_at = NOW()
       WHERE stripe_payment_intent_id = $1`,
      [paymentIntent.id]
    );

    logger.info('Payment intent failed', {
      paymentIntentId: paymentIntent.id,
      error: paymentIntent.last_payment_error,
    });
  });
}

async function handleChargeRefunded(charge: any) {
  const refundAmount = charge.amount_refunded / 100;
  
  await transaction(async (client) => {
    const result = await client.query(
      `UPDATE orders 
       SET status = 'refunded',
           updated_at = NOW()
       WHERE stripe_charge_id = $1
       RETURNING id, total_amount`,
      [charge.id]
    );

    if (result.rows.length > 0) {
      const order = result.rows[0];
      logger.info('Charge refunded', {
        chargeId: charge.id,
        orderId: order.id,
        refundAmount,
        partialRefund: refundAmount < order.total_amount,
      });
    }
  });
}

async function handleAccountUpdated(account: any) {
  await query(
    `UPDATE organizations 
     SET stripe_onboarding_completed = $1,
         updated_at = NOW()
     WHERE stripe_account_id = $2`,
    [account.charges_enabled && account.payouts_enabled, account.id]
  );

  logger.info('Connected account updated', {
    accountId: account.id,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
  });
}

async function handleAccountAuthorized(account: any) {
  logger.info('Connected account authorized', {
    accountId: account.id,
  });
}

async function handleTransferCreated(transfer: any) {
  logger.info('Transfer created', {
    transferId: transfer.id,
    amount: transfer.amount / 100,
    destination: transfer.destination,
  });
}

async function handlePayoutCreated(payout: any) {
  await query(
    `UPDATE payouts 
     SET stripe_payout_id = $1,
         status = 'processing',
         updated_at = NOW()
     WHERE stripe_transfer_id = $2`,
    [payout.id, payout.source_transaction]
  );

  logger.info('Payout created', {
    payoutId: payout.id,
    amount: payout.amount / 100,
  });
}

async function handlePayoutPaid(payout: any) {
  await query(
    `UPDATE payouts 
     SET status = 'paid',
         processed_at = NOW(),
         updated_at = NOW()
     WHERE stripe_payout_id = $1`,
    [payout.id]
  );

  logger.info('Payout paid', {
    payoutId: payout.id,
    amount: payout.amount / 100,
  });
}

async function handlePayoutFailed(payout: any) {
  await query(
    `UPDATE payouts 
     SET status = 'failed',
         updated_at = NOW()
     WHERE stripe_payout_id = $1`,
    [payout.id]
  );

  logger.error('Payout failed', {
    payoutId: payout.id,
    amount: payout.amount / 100,
    failureCode: payout.failure_code,
    failureMessage: payout.failure_message,
  });
}

async function handleCheckoutSessionCompleted(session: any) {
  const customerEmail = normalizeEmail(session.metadata?.email || session.customer_email || '');
  
  if (!customerEmail) {
    logger.error('No email found in checkout session', { sessionId: session.id });
    return;
  }

  await transaction(async (client) => {
    // Find user by email
    const userResult = await client.query(
      `SELECT u.*, s.id as subscription_id 
       FROM users u
       LEFT JOIN subscriptions s ON u.id = s.user_id
       WHERE u.email = $1`,
      [customerEmail]
    );

    if (userResult.rows.length === 0) {
      logger.error('User not found for checkout session', { email: customerEmail, sessionId: session.id });
      return;
    }

    const user = userResult.rows[0];
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ['data.price'],
      limit: 10,
    });

    const priceId = lineItems.data[0]?.price?.id;
    if (!priceId) {
      logger.error('No price ID found in checkout session', { sessionId: session.id });
      return;
    }

    // Determine tier from price ID (you'll need to map your Stripe price IDs)
    let tier: 'starter' | 'pro' | 'enterprise' = 'starter';
    if (priceId === process.env.STRIPE_PRICE_PRO) {
      tier = 'pro';
    } else if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) {
      tier = 'enterprise';
    }

    const pricing = PRICING_BY_TIER[tier];
    const features = DEFAULT_FEATURES_BY_TIER[tier];

    if (user.subscription_id) {
      // Update existing subscription
      await client.query(
        `UPDATE subscriptions 
         SET stripe_subscription_id = $1,
             stripe_customer_id = $2,
             tier = $3,
             status = 'active',
             monthly_price = $4,
             transaction_fee_rate = $5,
             features = $6,
             current_period_start = NOW(),
             updated_at = NOW()
         WHERE id = $7`,
        [
          session.subscription,
          session.customer,
          tier,
          pricing.monthly_price,
          pricing.transaction_fee_rate,
          features,
          user.subscription_id,
        ]
      );
    } else {
      // Create new subscription
      await client.query(
        `INSERT INTO subscriptions (
          user_id, organization_id, stripe_subscription_id,
          stripe_customer_id, tier, status, monthly_price,
          transaction_fee_rate, features, current_period_start
        ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, NOW())`,
        [
          user.id,
          user.organization_id,
          session.subscription,
          session.customer,
          tier,
          pricing.monthly_price,
          pricing.transaction_fee_rate,
          features,
        ]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (
        organization_id, user_id, action, entity_type, entity_id, changes
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.organization_id,
        user.id,
        'subscription.created',
        'subscription',
        session.subscription,
        { tier, priceId, sessionId: session.id },
      ]
    );
  });

  logger.info('Checkout session completed', {
    sessionId: session.id,
    email: customerEmail,
    subscriptionId: session.subscription,
  });
}

async function handleSubscriptionCreated(subscription: any) {
  await updateSubscriptionStatus(subscription, 'active');
}

async function handleSubscriptionUpdated(subscription: any) {
  const status = subscription.status === 'active' ? 'active' : 
                 subscription.status === 'past_due' ? 'past_due' :
                 subscription.status === 'canceled' ? 'canceled' :
                 subscription.status === 'incomplete' ? 'incomplete' : 'active';
  
  await updateSubscriptionStatus(subscription, status);
}

async function handleSubscriptionDeleted(subscription: any) {
  await updateSubscriptionStatus(subscription, 'canceled');
}

async function updateSubscriptionStatus(subscription: any, status: string) {
  await transaction(async (client) => {
    // Find subscription by Stripe ID
    const subResult = await client.query(
      `SELECT s.*, u.id as user_id, u.organization_id 
       FROM subscriptions s
       JOIN users u ON s.user_id = u.id
       WHERE s.stripe_subscription_id = $1`,
      [subscription.id]
    );

    if (subResult.rows.length === 0) {
      logger.warn('Subscription not found', { stripeSubscriptionId: subscription.id });
      return;
    }

    const sub = subResult.rows[0];
    
    // Update subscription status
    await client.query(
      `UPDATE subscriptions 
       SET status = $1,
           current_period_start = $2,
           current_period_end = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [
        status,
        subscription.current_period_start ? new Date(subscription.current_period_start * 1000) : null,
        subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
        sub.id,
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (
        organization_id, user_id, action, entity_type, entity_id, changes
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sub.organization_id,
        sub.user_id,
        `subscription.${status}`,
        'subscription',
        subscription.id,
        { status, previousStatus: sub.status },
      ]
    );
  });

  logger.info('Subscription status updated', {
    subscriptionId: subscription.id,
    status,
  });
}

async function handleInvoicePaymentSucceeded(invoice: any) {
  await transaction(async (client) => {
    // Update subscription payment status if needed
    if (invoice.subscription) {
      await client.query(
        `UPDATE subscriptions 
         SET status = 'active',
             updated_at = NOW()
         WHERE stripe_subscription_id = $1 AND status = 'past_due'`,
        [invoice.subscription]
      );
    }

    logger.info('Invoice payment succeeded', {
      invoiceId: invoice.id,
      subscriptionId: invoice.subscription,
      amount: invoice.amount_paid / 100,
    });
  });
}

async function handleInvoicePaymentFailed(invoice: any) {
  await transaction(async (client) => {
    if (invoice.subscription) {
      // Find subscription
      const subResult = await client.query(
        `SELECT * FROM subscriptions WHERE stripe_subscription_id = $1`,
        [invoice.subscription]
      );

      if (subResult.rows.length > 0) {
        const sub = subResult.rows[0];
        
        // Update to past_due status
        await client.query(
          `UPDATE subscriptions 
           SET status = 'past_due',
               updated_at = NOW()
           WHERE id = $1`,
          [sub.id]
        );

        // Log the failed payment
        await client.query(
          `INSERT INTO audit_logs (
            organization_id, user_id, action, entity_type, entity_id, changes
          ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            sub.organization_id,
            sub.user_id,
            'subscription.payment_failed',
            'subscription',
            invoice.subscription,
            { 
              invoiceId: invoice.id,
              amountDue: invoice.amount_due / 100,
              attemptCount: invoice.attempt_count,
            },
          ]
        );
      }
    }
  });

  logger.error('Invoice payment failed', {
    invoiceId: invoice.id,
    subscriptionId: invoice.subscription,
    amountDue: invoice.amount_due / 100,
  });
}

export default app;