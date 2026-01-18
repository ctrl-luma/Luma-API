import { Hono } from 'hono';
import { config } from '../../config';
import { stripeService, stripe } from '../../services/stripe';
import { logger } from '../../utils/logger';
import { query, transaction } from '../../db';
import { normalizeEmail } from '../../utils/email';
import { PRICING_BY_TIER, DEFAULT_FEATURES_BY_TIER } from '../../db/models/subscription';
import { socketService, SocketEvents } from '../../services/socket';
import { staffService } from '../../services/staff';
import { cacheService, CacheKeys } from '../../services/redis/cache';

const app = new Hono();

// Use plain Hono route (not OpenAPI) to get raw body for signature verification
app.post('/stripe/webhook', async (c) => {
  console.log('!!! WEBHOOK HIT !!! - /stripe/webhook received request');
  console.log('!!! Headers:', JSON.stringify(Object.fromEntries(c.req.raw.headers.entries())));

  const signature = c.req.header('stripe-signature');
  const rawBody = await c.req.text();

  console.log('!!! WEBHOOK - signature present:', !!signature, 'body length:', rawBody?.length);

  logger.info('[WEBHOOK DEBUG] Received webhook request', {
    hasSignature: !!signature,
    bodyLength: rawBody?.length || 0,
    webhookSecretConfigured: !!config.stripe.webhookSecret,
  });

  if (!signature) {
    logger.error('[WEBHOOK DEBUG] Missing stripe-signature header');
    return c.json({ error: 'Missing stripe-signature header' }, 400);
  }

  let event;
  try {
    event = stripeService.constructWebhookEvent(
      rawBody,
      signature,
      config.stripe.webhookSecret
    );
    logger.info('[WEBHOOK DEBUG] Signature verification PASSED', {
      eventId: event.id,
      eventType: event.type,
    });
  } catch (error) {
    logger.error('[WEBHOOK DEBUG] Webhook signature verification FAILED', {
      error: error instanceof Error ? error.message : String(error),
      signaturePrefix: signature?.substring(0, 20),
    });
    return c.json({ error: 'Invalid signature' }, 400);
  }

  logger.info('[WEBHOOK DEBUG] ========== WEBHOOK EVENT RECEIVED ==========', {
    type: event.type,
    id: event.id,
    created: event.created,
    livemode: event.livemode,
    apiVersion: event.api_version,
  });

  // Log full event data for payment-related events
  if (event.type.startsWith('payment_intent') || event.type.startsWith('charge')) {
    logger.info('[WEBHOOK DEBUG] Payment event full data', {
      eventType: event.type,
      eventId: event.id,
      dataObject: JSON.stringify(event.data.object, null, 2),
    });
  }

  try {
    logger.info('[WEBHOOK DEBUG] Processing event type', { eventType: event.type });

    switch (event.type) {
      case 'payment_intent.succeeded':
        logger.info('[WEBHOOK DEBUG] >>> Matched payment_intent.succeeded - calling handler');
        await handlePaymentIntentSucceeded(event.data.object);
        logger.info('[WEBHOOK DEBUG] <<< Finished payment_intent.succeeded handler');
        break;

      case 'payment_intent.payment_failed':
        logger.info('[WEBHOOK DEBUG] >>> Matched payment_intent.payment_failed');
        await handlePaymentIntentFailed(event.data.object);
        break;

      case 'charge.refunded':
        logger.info('[WEBHOOK DEBUG] >>> Matched charge.refunded');
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
        logger.info('[WEBHOOK DEBUG] Unhandled webhook event type (no handler)', { type: event.type });
    }

    logger.info('[WEBHOOK DEBUG] ========== WEBHOOK PROCESSING COMPLETE - Returning 200 ==========', {
      eventType: event.type,
      eventId: event.id,
    });
    return c.json({ received: true });
  } catch (error) {
    logger.error('[WEBHOOK DEBUG] ========== ERROR PROCESSING WEBHOOK ==========', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      eventType: event.type,
      eventId: event.id,
    });
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

async function handlePaymentIntentSucceeded(paymentIntent: any) {
  logger.info('[WEBHOOK DEBUG] ========== handlePaymentIntentSucceeded START ==========');
  logger.info('[WEBHOOK DEBUG] PaymentIntent details', {
    id: paymentIntent.id,
    amount: paymentIntent.amount,
    amountInDollars: paymentIntent.amount / 100,
    currency: paymentIntent.currency,
    status: paymentIntent.status,
    latestCharge: paymentIntent.latest_charge,
    paymentMethodType: paymentIntent.payment_method_types,
    metadata: paymentIntent.metadata,
    transferData: paymentIntent.transfer_data,
    onBehalfOf: paymentIntent.on_behalf_of,
    applicationFeeAmount: paymentIntent.application_fee_amount,
  });

  await transaction(async (client) => {
    logger.info('[WEBHOOK DEBUG] Looking for order with stripe_payment_intent_id', {
      paymentIntentId: paymentIntent.id,
    });

    // First, let's check if the order exists at all
    const checkResult = await client.query(
      `SELECT id, status, stripe_payment_intent_id, organization_id, total_amount
       FROM orders
       WHERE stripe_payment_intent_id = $1`,
      [paymentIntent.id]
    );

    logger.info('[WEBHOOK DEBUG] Order lookup result (before update)', {
      found: checkResult.rows.length > 0,
      rowCount: checkResult.rows.length,
      order: checkResult.rows[0] || null,
    });

    if (checkResult.rows.length === 0) {
      // Let's check recent orders to see what payment intent IDs they have
      const recentOrders = await client.query(
        `SELECT id, status, stripe_payment_intent_id, created_at
         FROM orders
         ORDER BY created_at DESC
         LIMIT 5`
      );
      logger.warn('[WEBHOOK DEBUG] No order found! Recent orders for debugging', {
        recentOrders: recentOrders.rows,
        searchedFor: paymentIntent.id,
      });
    }

    const result = await client.query(
      `UPDATE orders
       SET status = 'completed',
           stripe_charge_id = $1,
           updated_at = NOW()
       WHERE stripe_payment_intent_id = $2
       RETURNING id, organization_id, total_amount, status`,
      [paymentIntent.latest_charge, paymentIntent.id]
    );

    logger.info('[WEBHOOK DEBUG] Update query result', {
      rowsUpdated: result.rowCount,
      updatedOrder: result.rows[0] || null,
    });

    if (result.rows.length > 0) {
      const order = result.rows[0];
      logger.info('[WEBHOOK DEBUG] Order updated successfully, emitting socket events', {
        orderId: order.id,
        organizationId: order.organization_id,
        totalAmount: order.total_amount,
        newStatus: order.status,
      });

      // Emit socket events for real-time updates
      socketService.emitToOrganization(order.organization_id, SocketEvents.ORDER_COMPLETED, {
        orderId: order.id,
        amount: order.total_amount,
        timestamp: new Date(),
      });
      socketService.emitToOrganization(order.organization_id, SocketEvents.PAYMENT_RECEIVED, {
        orderId: order.id,
        amount: order.total_amount,
        timestamp: new Date(),
      });

      logger.info('[WEBHOOK DEBUG] Socket events emitted successfully');
    } else {
      logger.warn('[WEBHOOK DEBUG] No order was updated! The order might not exist or already be completed');
    }

    logger.info('[WEBHOOK DEBUG] Payment intent succeeded handler completed', {
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount / 100,
      orderFound: result.rows.length > 0,
    });
  });

  logger.info('[WEBHOOK DEBUG] ========== handlePaymentIntentSucceeded END ==========');
}

async function handlePaymentIntentFailed(paymentIntent: any) {
  await transaction(async (client) => {
    const result = await client.query(
      `UPDATE orders
       SET status = 'failed',
           updated_at = NOW()
       WHERE stripe_payment_intent_id = $1
       RETURNING id, organization_id`,
      [paymentIntent.id]
    );

    if (result.rows.length > 0) {
      const order = result.rows[0];

      // Emit socket event for real-time updates
      socketService.emitToOrganization(order.organization_id, SocketEvents.ORDER_FAILED, {
        orderId: order.id,
        error: paymentIntent.last_payment_error?.message || 'Payment failed',
        timestamp: new Date(),
      });
    }

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
       RETURNING id, organization_id, total_amount`,
      [charge.id]
    );

    if (result.rows.length > 0) {
      const order = result.rows[0];

      // Emit socket event for real-time updates
      socketService.emitToOrganization(order.organization_id, SocketEvents.ORDER_REFUNDED, {
        orderId: order.id,
        refundAmount,
        partialRefund: refundAmount < order.total_amount,
        timestamp: new Date(),
      });

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
  const result = await query<{ id: string }>(
    `UPDATE organizations
     SET stripe_onboarding_completed = $1,
         updated_at = NOW()
     WHERE stripe_account_id = $2
     RETURNING id`,
    [account.charges_enabled && account.payouts_enabled, account.id]
  );

  if (result.length > 0) {
    const organizationId = result[0].id;

    // Emit socket event for real-time updates
    socketService.emitToOrganization(organizationId, SocketEvents.CONNECT_STATUS_UPDATED, {
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      timestamp: new Date(),
    });
  }

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
    if (priceId === config.stripe.proPriceId) {
      tier = 'pro';
    } else if (priceId === config.stripe.enterprisePriceId) {
      tier = 'enterprise';
    }

    const pricing = PRICING_BY_TIER[tier];
    const features = DEFAULT_FEATURES_BY_TIER[tier];

    let subscriptionId: string;

    if (user.subscription_id) {
      // Update existing subscription - always set platform to 'stripe' for Stripe checkouts
      // Clear cancel_at/canceled_at since this is a new active subscription
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
             platform = 'stripe',
             cancel_at = NULL,
             canceled_at = NULL,
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
      subscriptionId = user.subscription_id;
    } else {
      // Create new subscription
      const insertResult = await client.query(
        `INSERT INTO subscriptions (
          user_id, organization_id, stripe_subscription_id,
          stripe_customer_id, tier, status, monthly_price,
          transaction_fee_rate, features, current_period_start, platform
        ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, NOW(), 'stripe')
        RETURNING id`,
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
      subscriptionId = insertResult.rows[0].id;
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
        subscriptionId,
        { tier, priceId, sessionId: session.id },
      ]
    );

    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(user.id));
    await cacheService.del(CacheKeys.userByEmail(customerEmail));

    // Emit socket event for real-time updates
    socketService.emitToOrganization(user.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'active',
      tier,
      platform: 'stripe',
    });

    // Enable staff accounts for Pro tier
    if (tier === 'pro' || tier === 'enterprise') {
      try {
        await staffService.enableAllStaff(user.organization_id);
        logger.info('Staff accounts enabled for new subscription', { organizationId: user.organization_id });
      } catch (error) {
        logger.error('Failed to enable staff accounts', { error, organizationId: user.organization_id });
      }
    }
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
  let organizationId: string | null = null;
  let previousStatus: string | null = null;
  let tier: string | null = null;

  await transaction(async (client) => {
    // Find subscription by Stripe ID
    const subResult = await client.query(
      `SELECT s.*, u.id as user_id, u.organization_id, u.email as user_email
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
    organizationId = sub.organization_id;
    previousStatus = sub.status;
    tier = sub.tier;

    // For active status, clear any old cancellation dates (unless Stripe says it's scheduled to cancel)
    const isActivating = status === 'active' || status === 'trialing';

    // Capture cancel_at and canceled_at from Stripe's subscription object
    // cancel_at = when the subscription will actually end (expiration date)
    // canceled_at = when the user clicked cancel
    const stripeCancelAt = subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null;
    const stripeCanceledAt = subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null;

    // Update subscription status
    await client.query(
      `UPDATE subscriptions
       SET status = $1,
           current_period_start = $2,
           current_period_end = $3,
           cancel_at = CASE
             WHEN $5 IS NOT NULL THEN $5
             WHEN $7 THEN NULL
             ELSE cancel_at
           END,
           canceled_at = CASE
             WHEN $6 IS NOT NULL THEN $6
             WHEN $7 THEN NULL
             ELSE canceled_at
           END,
           updated_at = NOW()
       WHERE id = $4`,
      [
        status,
        subscription.current_period_start ? new Date(subscription.current_period_start * 1000) : null,
        subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
        sub.id,
        stripeCancelAt,
        stripeCanceledAt,
        isActivating && !stripeCancelAt, // Only clear if activating AND Stripe doesn't have cancel_at set
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
        sub.id, // Use database UUID, not Stripe subscription ID
        { status, previousStatus: sub.status },
      ]
    );

    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(sub.user_id));
    if (sub.user_email) {
      await cacheService.del(CacheKeys.userByEmail(sub.user_email));
    }
  });

  // Handle staff account enable/disable based on subscription status change
  if (organizationId) {
    const inactiveStatuses = ['canceled', 'past_due', 'unpaid', 'incomplete_expired'];
    const activeStatuses = ['active', 'trialing'];

    const wasActive = previousStatus && activeStatuses.includes(previousStatus);
    const isNowActive = activeStatuses.includes(status);
    const isNowInactive = inactiveStatuses.includes(status);

    // Subscription became inactive - disable all staff
    if (wasActive && isNowInactive) {
      try {
        const disabledCount = await staffService.disableAllStaff(organizationId);
        logger.info('Staff accounts disabled due to subscription lapse', {
          organizationId,
          disabledCount,
          newStatus: status,
        });
      } catch (error) {
        logger.error('Failed to disable staff accounts', { error, organizationId });
      }
    }

    // Subscription became active - re-enable all staff
    if (!wasActive && isNowActive && previousStatus && inactiveStatuses.includes(previousStatus)) {
      try {
        const enabledCount = await staffService.enableAllStaff(organizationId);
        logger.info('Staff accounts re-enabled due to subscription reactivation', {
          organizationId,
          enabledCount,
          newStatus: status,
        });
      } catch (error) {
        logger.error('Failed to enable staff accounts', { error, organizationId });
      }
    }

    // Emit socket event for real-time updates
    socketService.emitToOrganization(organizationId, SocketEvents.SUBSCRIPTION_UPDATED, {
      status,
      tier: tier || 'starter',
      platform: 'stripe',
    });
  }

  logger.info('Subscription status updated', {
    subscriptionId: subscription.id,
    status,
  });
}

async function handleInvoicePaymentSucceeded(invoice: any) {
  await transaction(async (client) => {
    // Update subscription payment status if needed
    if (invoice.subscription) {
      // Get subscription info for socket event and cache invalidation
      const subResult = await client.query(
        `SELECT s.*, u.organization_id, u.email as user_email
         FROM subscriptions s
         JOIN users u ON s.user_id = u.id
         WHERE s.stripe_subscription_id = $1`,
        [invoice.subscription]
      );

      const wasUpdated = await client.query(
        `UPDATE subscriptions
         SET status = 'active',
             cancel_at = NULL,
             canceled_at = NULL,
             updated_at = NOW()
         WHERE stripe_subscription_id = $1 AND status IN ('incomplete', 'past_due', 'pending_payment')
         RETURNING id`,
        [invoice.subscription]
      );

      // Only emit events if we actually updated something
      if (wasUpdated.rows.length > 0 && subResult.rows.length > 0) {
        const sub = subResult.rows[0];

        // Invalidate user cache
        await cacheService.del(CacheKeys.user(sub.user_id));
        if (sub.user_email) {
          await cacheService.del(CacheKeys.userByEmail(sub.user_email));
        }

        // Emit socket event
        socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
          status: 'active',
          tier: sub.tier,
          platform: 'stripe',
        });
      }
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
      // Find subscription with user info for cache invalidation
      const subResult = await client.query(
        `SELECT s.*, u.organization_id, u.email as user_email
         FROM subscriptions s
         JOIN users u ON s.user_id = u.id
         WHERE s.stripe_subscription_id = $1`,
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
            sub.id,
            {
              invoiceId: invoice.id,
              amountDue: invoice.amount_due / 100,
              attemptCount: invoice.attempt_count,
            },
          ]
        );

        // Invalidate user cache
        await cacheService.del(CacheKeys.user(sub.user_id));
        if (sub.user_email) {
          await cacheService.del(CacheKeys.userByEmail(sub.user_email));
        }

        // Emit socket event
        socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
          status: 'past_due',
          tier: sub.tier,
          platform: 'stripe',
        });
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