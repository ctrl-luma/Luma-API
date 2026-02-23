import { Hono } from 'hono';
import { config } from '../../config';
import { stripeService } from '../../services/stripe';
import { logger } from '../../utils/logger';
import { transaction, query } from '../../db';
import { syncAccountFromStripe, deriveOnboardingState } from './connect';
import { socketService, SocketEvents } from '../../services/socket';
import { queueService, QueueName } from '../../services/queue';
import { getImageUrl } from '../../services/images';
import { redisService } from '../../services/redis';

const app = new Hono();

// Use plain Hono route (not OpenAPI) to get raw body for signature verification
app.post('/stripe/webhook-connect', async (c) => {
  const signature = c.req.header('stripe-signature');
  const rawBody = await c.req.text();

  logger.info('[CONNECT WEBHOOK DEBUG] Received webhook request', {
    hasSignature: !!signature,
    bodyLength: rawBody?.length || 0,
    webhookSecretConfigured: !!config.stripe.connectWebhookSecret,
  });

  if (!signature) {
    logger.error('[CONNECT WEBHOOK DEBUG] Missing stripe-signature header');
    return c.json({ error: 'Missing stripe-signature header' }, 400);
  }

  let event;
  try {
    event = stripeService.constructWebhookEvent(
      rawBody,
      signature,
      config.stripe.connectWebhookSecret || ''
    );
    logger.info('[CONNECT WEBHOOK DEBUG] Signature verification PASSED', {
      eventId: event.id,
      eventType: event.type,
    });
  } catch (error) {
    logger.error('[CONNECT WEBHOOK DEBUG] Signature verification FAILED', {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: 'Invalid signature' }, 400);
  }

  logger.info('[CONNECT WEBHOOK DEBUG] ========== CONNECT WEBHOOK EVENT RECEIVED ==========', {
    type: event.type,
    id: event.id,
    account: event.account,
    created: event.created,
    livemode: event.livemode,
  });

  // Idempotency check: skip if we've already processed this event
  const isNew = await redisService.setNX(`luma:webhook:stripe-connect:${event.id}`, '1', 86400);
  if (!isNew) {
    logger.info('Connect webhook event already processed, skipping', { eventId: event.id, eventType: event.type });
    return c.json({ received: true });
  }

  // Log full event data for payment-related events
  if (event.type.startsWith('payment_intent') || event.type.startsWith('charge')) {
    logger.info('[CONNECT WEBHOOK DEBUG] Payment event full data', {
      eventType: event.type,
      eventId: event.id,
      connectedAccount: event.account,
      dataObject: JSON.stringify(event.data.object, null, 2),
    });
  }

  try {
    logger.info('[CONNECT WEBHOOK DEBUG] Processing event type', { eventType: event.type });

    switch (event.type) {
      case 'payment_intent.succeeded':
        logger.info('[CONNECT WEBHOOK DEBUG] >>> Matched payment_intent.succeeded - calling handler');
        await handlePaymentIntentSucceeded(event.data.object, event.account);
        logger.info('[CONNECT WEBHOOK DEBUG] <<< Finished payment_intent.succeeded handler');
        break;

      case 'payment_intent.payment_failed':
        logger.info('[CONNECT WEBHOOK DEBUG] >>> Matched payment_intent.payment_failed');
        await handlePaymentIntentFailed(event.data.object, event.account);
        break;

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

      case 'charge.refunded':
        await handleChargeRefunded(event.data.object, event.account);
        break;

      // Invoice events (for custom vendor invoicing)
      case 'invoice.finalized':
        await handleInvoiceFinalized(event.data.object, event.account);
        break;

      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        await handleInvoicePaid(event.data.object, event.account);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object, event.account);
        break;

      case 'invoice.voided':
        await handleInvoiceVoided(event.data.object, event.account);
        break;

      case 'invoice.marked_uncollectible':
        await handleInvoiceMarkedUncollectible(event.data.object, event.account);
        break;

      case 'invoice.overdue':
        await handleInvoiceOverdue(event.data.object, event.account);
        break;

      // Dispute events
      case 'charge.dispute.created':
        await handleDisputeCreated(event.data.object, event.account);
        break;

      case 'charge.dispute.updated':
        await handleDisputeUpdated(event.data.object, event.account);
        break;

      case 'charge.dispute.closed':
        await handleDisputeClosed(event.data.object, event.account);
        break;

      case 'charge.dispute.funds_withdrawn':
        await handleDisputeFundsWithdrawn(event.data.object, event.account);
        break;

      case 'charge.dispute.funds_reinstated':
        await handleDisputeFundsReinstated(event.data.object, event.account);
        break;

      default:
        logger.info('[CONNECT WEBHOOK DEBUG] Unhandled event type (no handler)', { type: event.type });
    }

    logger.info('[CONNECT WEBHOOK DEBUG] ========== CONNECT WEBHOOK PROCESSING COMPLETE - Returning 200 ==========', {
      eventType: event.type,
      eventId: event.id,
    });
    return c.json({ received: true });
  } catch (error) {
    logger.error('[CONNECT WEBHOOK DEBUG] ========== ERROR PROCESSING CONNECT WEBHOOK ==========', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      eventType: event.type,
      eventId: event.id,
    });
    // Return 200 to prevent Stripe from retrying — idempotency key is already set,
    // and retries after TTL expiry could cause duplicate processing
    return c.json({ received: true });
  }
});

async function handleAccountUpdated(account: any, connectedAccountId: string | undefined) {
  const accountId = connectedAccountId || account.id;

  // Find the organization by stripe_account_id
  const orgRows = await query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE stripe_account_id = $1',
    [accountId]
  );

  if (orgRows.length === 0) {
    logger.warn('Organization not found for account update', { accountId });
    return;
  }

  const org = orgRows[0];

  // Use the centralized sync function to update all account data
  await syncAccountFromStripe(account, org.id);

  // Derive the onboarding state for the socket event
  const onboardingState = deriveOnboardingState(account);

  // Emit socket event to notify connected clients in real-time
  socketService.emitToOrganization(org.id, SocketEvents.CONNECT_STATUS_UPDATED, {
    organizationId: org.id,
    onboardingState,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    requirementsCurrentlyDue: account.requirements?.currently_due || [],
    requirementsPastDue: account.requirements?.past_due || [],
    disabledReason: account.requirements?.disabled_reason || null,
    timestamp: new Date().toISOString(),
  });

  // Log the audit event
  await transaction(async (client) => {
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
          details_submitted: account.details_submitted,
          requirements: account.requirements,
        },
      ]
    );
  });

  logger.info('Connected account updated via webhook', {
    accountId,
    organizationId: org.id,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    socketEventEmitted: true,
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
    const payoutResult = await client.query(
      `INSERT INTO payouts (
        organization_id, stripe_payout_id, amount, status,
        type, description, created_at
      ) VALUES ($1, $2, $3, 'processing', 'connect_payout', $4, NOW())
      ON CONFLICT (stripe_payout_id) DO UPDATE
      SET status = 'processing',
          updated_at = NOW()
      RETURNING id`,
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
        payoutResult.rows[0].id,
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
    // Update payout status to failed and get the payout UUID
    const payoutResult = await client.query(
      `UPDATE payouts
       SET status = 'failed',
           updated_at = NOW()
       WHERE stripe_payout_id = $1
       RETURNING id, organization_id`,
      [payout.id]
    );

    // Find organization for logging (use payout record if available, otherwise query)
    let orgId: string | null = null;
    if (payoutResult.rows.length > 0) {
      orgId = payoutResult.rows[0].organization_id;
    } else {
      const orgResult = await client.query(
        `SELECT id FROM organizations WHERE stripe_account_id = $1`,
        [connectedAccountId]
      );
      if (orgResult.rows.length > 0) {
        orgId = orgResult.rows[0].id;
      }
    }

    if (orgId && payoutResult.rows.length > 0) {
      await client.query(
        `INSERT INTO audit_logs (
          organization_id, action, entity_type, entity_id, changes
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          orgId,
          'connect_payout.failed',
          'payout',
          payoutResult.rows[0].id,
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

async function handlePaymentIntentSucceeded(paymentIntent: any, connectedAccountId: string | undefined) {
  logger.info('[CONNECT WEBHOOK DEBUG] ========== handlePaymentIntentSucceeded START ==========');
  logger.info('[CONNECT WEBHOOK DEBUG] PaymentIntent details', {
    id: paymentIntent.id,
    amount: paymentIntent.amount,
    amountInDollars: paymentIntent.amount / 100,
    currency: paymentIntent.currency,
    status: paymentIntent.status,
    latestCharge: paymentIntent.latest_charge,
    paymentMethodType: paymentIntent.payment_method_types,
    metadata: paymentIntent.metadata,
    connectedAccountId,
  });

  // Check if this is a preorder payment
  if (paymentIntent.metadata?.type === 'preorder') {
    logger.info('[CONNECT WEBHOOK DEBUG] This is a PREORDER payment, handling separately');
    await handlePreorderPaymentSucceeded(paymentIntent);
    logger.info('[CONNECT WEBHOOK DEBUG] ========== handlePaymentIntentSucceeded END (preorder) ==========');
    return;
  }

  await transaction(async (client) => {
    logger.info('[CONNECT WEBHOOK DEBUG] Looking for order with stripe_payment_intent_id', {
      paymentIntentId: paymentIntent.id,
    });

    // First, let's check if the order exists at all
    const checkResult = await client.query(
      `SELECT id, status, stripe_payment_intent_id, organization_id, total_amount, order_number
       FROM orders
       WHERE stripe_payment_intent_id = $1`,
      [paymentIntent.id]
    );

    logger.info('[CONNECT WEBHOOK DEBUG] Order lookup result (before update)', {
      found: checkResult.rows.length > 0,
      rowCount: checkResult.rows.length,
      order: checkResult.rows[0] || null,
    });

    if (checkResult.rows.length === 0) {
      // Check if this is an invoice payment via payment_details.order_reference
      const stripeInvoiceId = paymentIntent.payment_details?.order_reference;
      if (stripeInvoiceId && typeof stripeInvoiceId === 'string' && stripeInvoiceId.startsWith('in_')) {
        logger.info('[CONNECT WEBHOOK DEBUG] No order found but payment_details.order_reference contains invoice ID — handling as invoice payment', {
          stripeInvoiceId,
        });
        await handleInvoicePaymentFromPI(client, paymentIntent, stripeInvoiceId);
        return;
      }

      const recentOrders = await client.query(
        `SELECT id, status, stripe_payment_intent_id, order_number, created_at
         FROM orders
         ORDER BY created_at DESC
         LIMIT 5`
      );
      logger.warn('[CONNECT WEBHOOK DEBUG] No order found! Recent orders for debugging', {
        recentOrders: recentOrders.rows,
        searchedFor: paymentIntent.id,
      });
    }

    // Update order status to completed
    const result = await client.query(
      `UPDATE orders
       SET status = 'completed',
           stripe_charge_id = $1,
           updated_at = NOW()
       WHERE stripe_payment_intent_id = $2
       RETURNING id, order_number, organization_id, catalog_id, total_amount, status`,
      [paymentIntent.latest_charge, paymentIntent.id]
    );

    logger.info('[CONNECT WEBHOOK DEBUG] Update query result', {
      rowsUpdated: result.rowCount,
      updatedOrder: result.rows[0] || null,
    });

    if (result.rows.length > 0) {
      const order = result.rows[0];

      logger.info('[CONNECT WEBHOOK DEBUG] Order updated successfully, emitting socket events', {
        orderId: order.id,
        orderNumber: order.order_number,
        organizationId: order.organization_id,
        catalogId: order.catalog_id,
        totalAmount: order.total_amount,
        newStatus: order.status,
      });

      // Emit socket events for real-time updates
      socketService.emitToOrganization(order.organization_id, SocketEvents.ORDER_COMPLETED, {
        orderId: order.id,
        orderNumber: order.order_number,
        amount: order.total_amount,
        timestamp: new Date().toISOString(),
      });
      socketService.emitToOrganization(order.organization_id, SocketEvents.PAYMENT_RECEIVED, {
        orderId: order.id,
        amount: order.total_amount,
        timestamp: new Date().toISOString(),
      });

      logger.info('[CONNECT WEBHOOK DEBUG] Socket events emitted successfully');
    } else {
      logger.warn('[CONNECT WEBHOOK DEBUG] No order was updated! The order might not exist or already be completed');
    }
  });

  logger.info('[CONNECT WEBHOOK DEBUG] ========== handlePaymentIntentSucceeded END ==========');
}

// Fallback: handle invoice payment from payment_intent.succeeded when invoice.paid/payment_succeeded webhook doesn't arrive
async function handleInvoicePaymentFromPI(client: any, paymentIntent: any, stripeInvoiceId: string) {
  const amountPaid = (paymentIntent.amount_received || paymentIntent.amount || 0) / 100;

  const updatedRows = await client.query(
    `UPDATE invoices SET
      status = 'paid',
      amount_paid = $1,
      amount_due = 0,
      stripe_payment_intent_id = $2,
      stripe_charge_id = $3,
      paid_at = NOW(),
      updated_at = NOW()
    WHERE stripe_invoice_id = $4 AND status IN ('open', 'past_due')
    RETURNING id, organization_id, customer_email, customer_name, invoice_number, total_amount, customer_id`,
    [amountPaid, paymentIntent.id, paymentIntent.latest_charge, stripeInvoiceId]
  );

  if (updatedRows.rows.length > 0) {
    const inv = updatedRows.rows[0];

    // Update customer total_spent if linked
    if (inv.customer_id) {
      await client.query(
        `UPDATE customers SET
          total_spent = total_spent + $1,
          total_orders = total_orders + 1,
          last_order_at = NOW(),
          updated_at = NOW()
        WHERE id = $2`,
        [parseFloat(inv.total_amount), inv.customer_id]
      );
    }

    const orgRows = await client.query(
      'SELECT name, branding_logo_id FROM organizations WHERE id = $1',
      [inv.organization_id]
    );

    const orgName = orgRows.rows[0]?.name || 'Your vendor';
    const brandingLogoId = orgRows.rows[0]?.branding_logo_id || null;

    // Queue payment confirmation email
    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'invoice_paid',
      to: inv.customer_email,
      vendorBranding: {
        organizationName: orgName,
        brandingLogoUrl: getImageUrl(brandingLogoId),
      },
      data: {
        customerName: inv.customer_name,
        invoiceNumber: inv.invoice_number,
        organizationName: orgName,
        totalAmount: parseFloat(inv.total_amount),
        pdfUrl: null,
      },
    });

    socketService.emitToOrganization(inv.organization_id, SocketEvents.INVOICE_PAID, {
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      customerName: inv.customer_name,
      totalAmount: parseFloat(inv.total_amount),
    });

    logger.info('Invoice marked paid via payment_intent.succeeded fallback', {
      invoiceId: inv.id,
      stripeInvoiceId,
      paymentIntentId: paymentIntent.id,
      amountPaid,
    });
  } else {
    logger.warn('Invoice not found or already paid for payment_intent.succeeded fallback', {
      stripeInvoiceId,
      paymentIntentId: paymentIntent.id,
    });
  }
}

async function handlePreorderPaymentSucceeded(paymentIntent: any) {
  logger.info('[PREORDER WEBHOOK] ========== handlePreorderPaymentSucceeded START ==========');

  await transaction(async (client) => {
    logger.info('[PREORDER WEBHOOK] Looking for preorder with stripe_payment_intent_id', {
      paymentIntentId: paymentIntent.id,
      preorderNumber: paymentIntent.metadata?.preorder_number,
    });

    // Update preorder with charge ID (payment already confirmed at creation)
    const result = await client.query(
      `UPDATE preorders
       SET stripe_charge_id = $1,
           updated_at = NOW()
       WHERE stripe_payment_intent_id = $2
       RETURNING id, order_number, organization_id, catalog_id, total_amount, status, customer_email, customer_name`,
      [paymentIntent.latest_charge, paymentIntent.id]
    );

    logger.info('[PREORDER WEBHOOK] Update query result', {
      rowsUpdated: result.rowCount,
      updatedPreorder: result.rows[0] || null,
    });

    if (result.rows.length > 0) {
      const preorder = result.rows[0];

      logger.info('[PREORDER WEBHOOK] Preorder updated successfully, emitting socket events', {
        preorderId: preorder.id,
        orderNumber: preorder.order_number,
        organizationId: preorder.organization_id,
        catalogId: preorder.catalog_id,
        totalAmount: preorder.total_amount,
        newStatus: preorder.status,
      });

      // Emit socket events for real-time updates to vendor
      socketService.emitToOrganization(preorder.organization_id, SocketEvents.PREORDER_CREATED, {
        preorderId: preorder.id,
        orderNumber: preorder.order_number,
        customerName: preorder.customer_name,
        totalAmount: preorder.total_amount,
        status: preorder.status,
        timestamp: new Date().toISOString(),
      });

      // Emit to customer waiting on success page
      socketService.emitToPreorder(preorder.id, SocketEvents.PREORDER_UPDATED, {
        preorderId: preorder.id,
        orderNumber: preorder.order_number,
        status: preorder.status,
        timestamp: new Date().toISOString(),
      });

      logger.info('[PREORDER WEBHOOK] Socket events emitted successfully');
    } else {
      logger.warn('[PREORDER WEBHOOK] No preorder was updated! Checking if it exists...', {
        searchedFor: paymentIntent.id,
      });

      // Debug: check recent preorders
      const recentPreorders = await client.query(
        `SELECT id, status, stripe_payment_intent_id, order_number, created_at
         FROM preorders
         ORDER BY created_at DESC
         LIMIT 5`
      );
      logger.warn('[PREORDER WEBHOOK] Recent preorders for debugging', {
        recentPreorders: recentPreorders.rows,
      });
    }
  });

  logger.info('[PREORDER WEBHOOK] ========== handlePreorderPaymentSucceeded END ==========');
}

async function handlePaymentIntentFailed(paymentIntent: any, connectedAccountId: string | undefined) {
  await transaction(async (client) => {
    const result = await client.query(
      `UPDATE orders
       SET status = 'failed',
           updated_at = NOW()
       WHERE stripe_payment_intent_id = $1
       RETURNING id, order_number, organization_id`,
      [paymentIntent.id]
    );

    if (result.rows.length > 0) {
      const order = result.rows[0];

      logger.info('Order marked as failed via Connect webhook', {
        orderId: order.id,
        orderNumber: order.order_number,
        paymentIntentId: paymentIntent.id,
        connectedAccountId,
        failureMessage: paymentIntent.last_payment_error?.message,
      });

      // Emit socket event for real-time updates
      socketService.emitToOrganization(order.organization_id, SocketEvents.ORDER_FAILED, {
        orderId: order.id,
        orderNumber: order.order_number,
        error: paymentIntent.last_payment_error?.message || 'Payment failed',
        timestamp: new Date().toISOString(),
      });
    }
  });
}

async function handleChargeRefunded(charge: any, connectedAccountId: string | undefined) {
  const refundAmount = charge.amount_refunded / 100;
  const isFullRefund = charge.refunded === true;

  await transaction(async (client) => {
    // Determine the new status based on refund type
    const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';

    const result = await client.query(
      `UPDATE orders
       SET status = $1,
           updated_at = NOW()
       WHERE stripe_charge_id = $2
       RETURNING id, order_number, organization_id, total_amount`,
      [newStatus, charge.id]
    );

    if (result.rows.length > 0) {
      const order = result.rows[0];

      logger.info('Order refunded via Connect webhook', {
        orderId: order.id,
        orderNumber: order.order_number,
        chargeId: charge.id,
        refundAmount,
        totalAmount: order.total_amount,
        isFullRefund,
        status: newStatus,
        connectedAccountId,
      });

      // Emit socket event for real-time updates
      socketService.emitToOrganization(order.organization_id, SocketEvents.ORDER_REFUNDED, {
        orderId: order.id,
        orderNumber: order.order_number,
        refundAmount,
        isFullRefund,
        timestamp: new Date().toISOString(),
      });
    } else {
      logger.warn('No order found for refunded charge', {
        chargeId: charge.id,
        connectedAccountId,
      });
    }
  });
}

// ─── Invoice Webhook Handlers ────────────────────────────────────────────────

async function handleInvoiceFinalized(stripeInvoice: any, _connectedAccountId: string | undefined) {
  const lumaInvoiceId = stripeInvoice.metadata?.luma_invoice_id;
  if (!lumaInvoiceId) {
    logger.debug('Invoice finalized webhook skipped - no luma_invoice_id in metadata', {
      stripeInvoiceId: stripeInvoice.id,
    });
    return;
  }

  await query(
    `UPDATE invoices SET
      stripe_hosted_url = $1,
      stripe_pdf_url = $2,
      status = 'open',
      updated_at = NOW()
    WHERE id = $3`,
    [stripeInvoice.hosted_invoice_url, stripeInvoice.invoice_pdf, lumaInvoiceId]
  );

  const invoiceRows = await query<{ organization_id: string }>(
    'SELECT organization_id FROM invoices WHERE id = $1',
    [lumaInvoiceId]
  );
  if (invoiceRows.length > 0) {
    socketService.emitToOrganization(invoiceRows[0].organization_id, SocketEvents.INVOICE_UPDATED, {
      invoiceId: lumaInvoiceId,
      status: 'open',
    });
  }

  logger.info('Invoice finalized via webhook', { lumaInvoiceId, stripeInvoiceId: stripeInvoice.id });
}

async function handleInvoicePaid(stripeInvoice: any, _connectedAccountId: string | undefined) {
  const lumaInvoiceId = stripeInvoice.metadata?.luma_invoice_id;
  if (!lumaInvoiceId) return;

  const amountPaid = (stripeInvoice.amount_paid || 0) / 100;

  const updatedRows = await query<{
    organization_id: string;
    customer_email: string;
    customer_name: string;
    invoice_number: string;
    total_amount: any;
    customer_id: string | null;
  }>(
    `UPDATE invoices SET
      status = 'paid',
      amount_paid = $1,
      amount_due = 0,
      stripe_payment_intent_id = $2,
      stripe_charge_id = $3,
      stripe_hosted_url = $4,
      stripe_pdf_url = $5,
      paid_at = NOW(),
      updated_at = NOW()
    WHERE id = $6
    RETURNING organization_id, customer_email, customer_name, invoice_number, total_amount, customer_id`,
    [
      amountPaid,
      stripeInvoice.payment_intent,
      stripeInvoice.charge,
      stripeInvoice.hosted_invoice_url,
      stripeInvoice.invoice_pdf,
      lumaInvoiceId,
    ]
  );

  if (updatedRows.length > 0) {
    const inv = updatedRows[0];

    // Update customer total_spent if linked
    if (inv.customer_id) {
      await query(
        `UPDATE customers SET
          total_spent = total_spent + $1,
          total_orders = total_orders + 1,
          last_order_at = NOW(),
          updated_at = NOW()
        WHERE id = $2`,
        [parseFloat(inv.total_amount), inv.customer_id]
      );
    }

    // Get org name and branding for email
    const orgRows = await query<{ name: string; branding_logo_id: string | null }>(
      'SELECT name, branding_logo_id FROM organizations WHERE id = $1',
      [inv.organization_id]
    );

    const orgName = orgRows[0]?.name || 'Your vendor';
    const brandingLogoId = orgRows[0]?.branding_logo_id || null;

    // Queue payment confirmation email
    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'invoice_paid',
      to: inv.customer_email,
      vendorBranding: {
        organizationName: orgName,
        brandingLogoUrl: getImageUrl(brandingLogoId),
      },
      data: {
        customerName: inv.customer_name,
        invoiceNumber: inv.invoice_number,
        organizationName: orgName,
        totalAmount: parseFloat(inv.total_amount),
        pdfUrl: stripeInvoice.invoice_pdf || null,
      },
    });

    socketService.emitToOrganization(inv.organization_id, SocketEvents.INVOICE_PAID, {
      invoiceId: lumaInvoiceId,
      invoiceNumber: inv.invoice_number,
      customerName: inv.customer_name,
      totalAmount: parseFloat(inv.total_amount),
    });

    logger.info('Invoice paid via webhook', {
      lumaInvoiceId,
      stripeInvoiceId: stripeInvoice.id,
      amountPaid,
      organizationId: inv.organization_id,
    });
  }
}

async function handleInvoicePaymentFailed(stripeInvoice: any, _connectedAccountId: string | undefined) {
  const lumaInvoiceId = stripeInvoice.metadata?.luma_invoice_id;
  if (!lumaInvoiceId) return;

  // Update status to past_due on payment failure
  const updatedRows = await query<{
    organization_id: string;
    customer_email: string;
    customer_name: string;
    invoice_number: string;
    total_amount: any;
    stripe_hosted_url: string | null;
  }>(
    `UPDATE invoices SET
      status = 'past_due',
      updated_at = NOW()
    WHERE id = $1 AND status IN ('open', 'past_due')
    RETURNING organization_id, customer_email, customer_name, invoice_number, total_amount, stripe_hosted_url`,
    [lumaInvoiceId]
  );

  if (updatedRows.length > 0) {
    const inv = updatedRows[0];

    const orgRows = await query<{ name: string; branding_logo_id: string | null }>(
      'SELECT name, branding_logo_id FROM organizations WHERE id = $1',
      [inv.organization_id]
    );

    const orgName = orgRows[0]?.name || 'Your vendor';
    const brandingLogoId = orgRows[0]?.branding_logo_id || null;

    // Queue payment failure email
    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'invoice_payment_failed',
      to: inv.customer_email,
      vendorBranding: {
        organizationName: orgName,
        brandingLogoUrl: getImageUrl(brandingLogoId),
      },
      data: {
        customerName: inv.customer_name,
        invoiceNumber: inv.invoice_number,
        organizationName: orgName,
        totalAmount: parseFloat(inv.total_amount),
        hostedUrl: inv.stripe_hosted_url || stripeInvoice.hosted_invoice_url || '',
      },
    });

    socketService.emitToOrganization(inv.organization_id, SocketEvents.INVOICE_PAYMENT_FAILED, {
      invoiceId: lumaInvoiceId,
      invoiceNumber: inv.invoice_number,
      status: 'past_due',
    });

    logger.warn('Invoice payment failed via webhook — status set to past_due', {
      lumaInvoiceId,
      stripeInvoiceId: stripeInvoice.id,
      organizationId: inv.organization_id,
    });
  }
}

async function handleInvoiceVoided(stripeInvoice: any, _connectedAccountId: string | undefined) {
  const lumaInvoiceId = stripeInvoice.metadata?.luma_invoice_id;
  if (!lumaInvoiceId) return;

  const updatedRows = await query<{ organization_id: string }>(
    `UPDATE invoices SET status = 'void', voided_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING organization_id`,
    [lumaInvoiceId]
  );

  if (updatedRows.length > 0) {
    socketService.emitToOrganization(updatedRows[0].organization_id, SocketEvents.INVOICE_VOIDED, {
      invoiceId: lumaInvoiceId,
    });
  }

  logger.info('Invoice voided via webhook', { lumaInvoiceId, stripeInvoiceId: stripeInvoice.id });
}

async function handleInvoiceMarkedUncollectible(stripeInvoice: any, _connectedAccountId: string | undefined) {
  const lumaInvoiceId = stripeInvoice.metadata?.luma_invoice_id;
  if (!lumaInvoiceId) return;

  const updatedRows = await query<{ organization_id: string }>(
    `UPDATE invoices SET status = 'uncollectible', updated_at = NOW() WHERE id = $1 RETURNING organization_id`,
    [lumaInvoiceId]
  );

  if (updatedRows.length > 0) {
    socketService.emitToOrganization(updatedRows[0].organization_id, SocketEvents.INVOICE_UPDATED, {
      invoiceId: lumaInvoiceId,
      status: 'uncollectible',
    });
  }

  logger.info('Invoice marked uncollectible via webhook', { lumaInvoiceId, stripeInvoiceId: stripeInvoice.id });
}

async function handleInvoiceOverdue(stripeInvoice: any, _connectedAccountId: string | undefined) {
  const lumaInvoiceId = stripeInvoice.metadata?.luma_invoice_id;
  if (!lumaInvoiceId) return;

  const updatedRows = await query<{ organization_id: string; invoice_number: string }>(
    `UPDATE invoices SET
      status = 'past_due',
      updated_at = NOW()
    WHERE id = $1 AND status = 'open'
    RETURNING organization_id, invoice_number`,
    [lumaInvoiceId]
  );

  if (updatedRows.length > 0) {
    socketService.emitToOrganization(updatedRows[0].organization_id, SocketEvents.INVOICE_OVERDUE, {
      invoiceId: lumaInvoiceId,
      invoiceNumber: updatedRows[0].invoice_number,
      status: 'past_due',
    });
  }

  logger.info('Invoice overdue via webhook — status set to past_due', { lumaInvoiceId, stripeInvoiceId: stripeInvoice.id });
}

// ─── Dispute Webhook Handlers ─────────────────────────────────────────────────

async function handleDisputeCreated(dispute: any, connectedAccountId: string | undefined) {
  const accountId = connectedAccountId || dispute.charge?.account;

  // Find organization
  const orgRows = await query<{ id: string; name: string }>(
    'SELECT o.id, o.name FROM organizations o WHERE o.stripe_account_id = $1',
    [accountId]
  );
  if (orgRows.length === 0) {
    logger.warn('Organization not found for dispute', { accountId, disputeId: dispute.id });
    return;
  }
  const org = orgRows[0];

  // Resolve charge ID
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;

  // Attempt to link to an existing entity by charge_id
  let orderId: string | null = null;
  let preorderId: string | null = null;
  let invoiceId: string | null = null;
  let ticketId: string | null = null;

  if (chargeId) {
    const orderRows = await query<{ id: string }>(
      'SELECT id FROM orders WHERE stripe_charge_id = $1 AND organization_id = $2',
      [chargeId, org.id]
    );
    if (orderRows.length > 0) {
      orderId = orderRows[0].id;
    } else {
      const preorderRows = await query<{ id: string }>(
        'SELECT id FROM preorders WHERE stripe_charge_id = $1 AND organization_id = $2',
        [chargeId, org.id]
      );
      if (preorderRows.length > 0) {
        preorderId = preorderRows[0].id;
      } else {
        const invoiceRows = await query<{ id: string }>(
          'SELECT id FROM invoices WHERE stripe_charge_id = $1 AND organization_id = $2',
          [chargeId, org.id]
        );
        if (invoiceRows.length > 0) {
          invoiceId = invoiceRows[0].id;
        } else {
          const ticketRows = await query<{ id: string }>(
            'SELECT id FROM tickets WHERE stripe_charge_id = $1',
            [chargeId]
          );
          if (ticketRows.length > 0) {
            ticketId = ticketRows[0].id;
          }
        }
      }
    }
  }

  // Construct Stripe Dashboard URL
  const isLive = dispute.livemode !== false;
  const dashboardBase = isLive
    ? 'https://dashboard.stripe.com'
    : 'https://dashboard.stripe.com/test';
  const stripeDashboardUrl = `${dashboardBase}/disputes/${dispute.id}`;

  // Insert dispute record (upsert for idempotency)
  const result = await query<{ id: string }>(
    `INSERT INTO disputes (
      organization_id, stripe_dispute_id, stripe_charge_id,
      stripe_payment_intent_id, amount, currency, reason, status,
      customer_email, customer_name,
      order_id, preorder_id, invoice_id, ticket_id,
      is_charge_refundable, stripe_dashboard_url,
      evidence_due_by, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
    ON CONFLICT (stripe_dispute_id) DO UPDATE SET
      status = EXCLUDED.status,
      reason = EXCLUDED.reason,
      amount = EXCLUDED.amount,
      updated_at = NOW()
    RETURNING id`,
    [
      org.id,
      dispute.id,
      chargeId,
      dispute.payment_intent || null,
      dispute.amount,
      dispute.currency || 'usd',
      dispute.reason || null,
      dispute.status,
      dispute.evidence?.customer_email_address || null,
      dispute.evidence?.customer_name || null,
      orderId,
      preorderId,
      invoiceId,
      ticketId,
      dispute.is_charge_refundable || false,
      stripeDashboardUrl,
      dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
        : null,
    ]
  );

  // Emit socket event
  socketService.emitToOrganization(org.id, SocketEvents.DISPUTE_CREATED, {
    disputeId: result[0].id,
    stripeDisputeId: dispute.id,
    amount: dispute.amount,
    reason: dispute.reason,
    status: dispute.status,
    timestamp: new Date().toISOString(),
  });

  // Queue email to org owner
  const ownerRows = await query<{ email: string; first_name: string }>(
    `SELECT email, first_name FROM users
     WHERE organization_id = $1 AND role = 'owner' AND is_active = true
     LIMIT 1`,
    [org.id]
  );
  if (ownerRows.length > 0) {
    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'dispute_created',
      to: ownerRows[0].email,
      data: {
        firstName: ownerRows[0].first_name,
        organizationName: org.name,
        amount: dispute.amount,
        currency: dispute.currency || 'usd',
        reason: dispute.reason || 'unknown',
        status: dispute.status,
        stripeDashboardUrl,
        evidenceDueBy: dispute.evidence_details?.due_by
          ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
          : null,
      },
    });
  }

  logger.info('Dispute created and stored', {
    disputeId: dispute.id,
    organizationId: org.id,
    amount: dispute.amount,
    reason: dispute.reason,
    orderId, preorderId, invoiceId, ticketId,
  });
}

async function handleDisputeUpdated(dispute: any, _connectedAccountId: string | undefined) {
  const result = await query<{ id: string; organization_id: string }>(
    `UPDATE disputes SET
      status = $1, reason = $2,
      is_charge_refundable = $3,
      evidence_due_by = $4,
      updated_at = NOW()
    WHERE stripe_dispute_id = $5
    RETURNING id, organization_id`,
    [
      dispute.status,
      dispute.reason || null,
      dispute.is_charge_refundable || false,
      dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
        : null,
      dispute.id,
    ]
  );

  if (result.length > 0) {
    socketService.emitToOrganization(result[0].organization_id, SocketEvents.DISPUTE_UPDATED, {
      disputeId: result[0].id,
      status: dispute.status,
      reason: dispute.reason,
      timestamp: new Date().toISOString(),
    });
  }

  logger.info('Dispute updated', { disputeId: dispute.id, status: dispute.status });
}

async function handleDisputeClosed(dispute: any, _connectedAccountId: string | undefined) {
  const result = await query<{ id: string; organization_id: string }>(
    `UPDATE disputes SET
      status = $1,
      closed_at = NOW(),
      updated_at = NOW()
    WHERE stripe_dispute_id = $2
    RETURNING id, organization_id`,
    [dispute.status, dispute.id]
  );

  if (result.length > 0) {
    socketService.emitToOrganization(result[0].organization_id, SocketEvents.DISPUTE_CLOSED, {
      disputeId: result[0].id,
      status: dispute.status,
      timestamp: new Date().toISOString(),
    });
  }

  logger.info('Dispute closed', { disputeId: dispute.id, status: dispute.status });
}

async function handleDisputeFundsWithdrawn(dispute: any, _connectedAccountId: string | undefined) {
  const result = await query<{ id: string; organization_id: string }>(
    `UPDATE disputes SET
      funds_withdrawn = true,
      status = $1,
      updated_at = NOW()
    WHERE stripe_dispute_id = $2
    RETURNING id, organization_id`,
    [dispute.status, dispute.id]
  );

  if (result.length > 0) {
    socketService.emitToOrganization(result[0].organization_id, SocketEvents.DISPUTE_UPDATED, {
      disputeId: result[0].id,
      status: dispute.status,
      fundsWithdrawn: true,
      timestamp: new Date().toISOString(),
    });
  }

  logger.info('Dispute funds withdrawn', { disputeId: dispute.id });
}

async function handleDisputeFundsReinstated(dispute: any, _connectedAccountId: string | undefined) {
  const result = await query<{ id: string; organization_id: string }>(
    `UPDATE disputes SET
      funds_reinstated = true,
      status = $1,
      updated_at = NOW()
    WHERE stripe_dispute_id = $2
    RETURNING id, organization_id`,
    [dispute.status, dispute.id]
  );

  if (result.length > 0) {
    socketService.emitToOrganization(result[0].organization_id, SocketEvents.DISPUTE_UPDATED, {
      disputeId: result[0].id,
      status: dispute.status,
      fundsReinstated: true,
      timestamp: new Date().toISOString(),
    });
  }

  logger.info('Dispute funds reinstated', { disputeId: dispute.id });
}

export default app;