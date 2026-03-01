import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../../db';
import { StripeConnectedAccount } from '../../db/models';
import { stripe } from '../../services/stripe';
import { emailService } from '../../services/email';
import { logger } from '../../utils/logger';
import { calculatePlatformFee, SubscriptionTier } from '../../config/platform-fees';
import { getOrgCurrency, toSmallestUnit, formatCurrency as formatCurrencyUtil } from '../../utils/currency';

const app = new OpenAPIHono();

// Helper to verify auth and get connected account
async function getConnectedAccount(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Terminal auth failed: missing or invalid auth header');
    throw new Error('Unauthorized');
  }

  const token = authHeader.substring(7);
  const { authService } = await import('../../services/auth');
  const payload = await authService.verifyToken(token);

  logger.info('Terminal: Looking up connected account', {
    organizationId: payload.organizationId,
    userId: payload.userId,
  });

  const rows = await query<StripeConnectedAccount>(
    'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
    [payload.organizationId]
  );

  logger.info('Terminal: Connected account lookup result', {
    organizationId: payload.organizationId,
    found: rows.length > 0,
    chargesEnabled: rows.length > 0 ? rows[0].charges_enabled : null,
    stripeAccountId: rows.length > 0 ? rows[0].stripe_account_id : null,
  });

  if (rows.length === 0) {
    logger.warn('Terminal: No connected account found', {
      organizationId: payload.organizationId,
    });
    throw new Error('No connected account found');
  }

  const connectedAccount = rows[0];

  if (!connectedAccount.charges_enabled) {
    logger.warn('Terminal: Charges not enabled', {
      organizationId: payload.organizationId,
      stripeAccountId: connectedAccount.stripe_account_id,
    });
    throw new Error('Payments are not enabled for this account');
  }

  // Get subscription tier for the organization
  // First try by organization_id, then fall back to user_id (for owner's subscription)
  let subscriptionRows = await query<{ tier: SubscriptionTier }>(
    `SELECT tier FROM subscriptions
     WHERE organization_id = $1 AND status IN ('active', 'trialing')
     ORDER BY created_at DESC LIMIT 1`,
    [payload.organizationId]
  );

  // If not found by org, check if user has a subscription (they might be the owner)
  if (subscriptionRows.length === 0) {
    subscriptionRows = await query<{ tier: SubscriptionTier }>(
      `SELECT tier FROM subscriptions
       WHERE user_id = $1 AND status IN ('active', 'trialing')
       ORDER BY created_at DESC LIMIT 1`,
      [payload.userId]
    );
  }

  const subscriptionFound = subscriptionRows.length > 0;
  const subscriptionTier: SubscriptionTier = subscriptionFound
    ? subscriptionRows[0].tier
    : 'starter'; // Default to starter (free) if no subscription

  logger.info('Subscription lookup for platform fee', {
    organizationId: payload.organizationId,
    userId: payload.userId,
    subscriptionFound,
    subscriptionTier,
  });

  // Get org currency
  const orgCurrency = connectedAccount.default_currency || await getOrgCurrency(payload.organizationId);

  return { connectedAccount, payload, subscriptionTier, orgCurrency };
}

// ============================================
// GET /stripe/terminal/location - Get or create a Terminal location for Tap to Pay
// ============================================
const getLocationRoute = createRoute({
  method: 'get',
  path: '/stripe/terminal/location',
  summary: 'Get or create a Terminal location for Tap to Pay',
  description: 'Returns an existing Terminal location or creates one if none exists. Required for local mobile reader (Tap to Pay).',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Terminal location retrieved/created successfully',
      content: {
        'application/json': {
          schema: z.object({
            locationId: z.string(),
            displayName: z.string(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Payments not enabled for this account' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(getLocationRoute, async (c) => {
  logger.info('Terminal location request received');

  try {
    const { connectedAccount, payload } = await getConnectedAccount(c.req.header('Authorization'));

    logger.info('Terminal: Fetching locations from Stripe', {
      stripeAccountId: connectedAccount.stripe_account_id,
    });

    // Try to find an existing location for this account
    const existingLocations = await stripe.terminal.locations.list(
      { limit: 1 },
      { stripeAccount: connectedAccount.stripe_account_id }
    );

    logger.info('Terminal: Stripe locations response', {
      count: existingLocations.data.length,
      stripeAccountId: connectedAccount.stripe_account_id,
    });

    if (existingLocations.data.length > 0) {
      const location = existingLocations.data[0];
      logger.info('Using existing Terminal location', {
        locationId: location.id,
        accountId: connectedAccount.stripe_account_id,
      });
      return c.json({
        locationId: location.id,
        displayName: location.display_name,
      });
    }

    // No location exists, create one
    // Get organization name for the display name
    const orgRows = await query<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [payload.organizationId]
    );
    const orgName = orgRows.length > 0 ? orgRows[0].name : 'Mobile POS';

    const newLocation = await stripe.terminal.locations.create(
      {
        display_name: `${orgName} - Tap to Pay`,
        address: {
          line1: '123 Main St', // Placeholder - required by Stripe
          city: 'San Francisco',
          state: 'CA',
          postal_code: '94111',
          country: 'US',
        },
      },
      { stripeAccount: connectedAccount.stripe_account_id }
    );

    logger.info('Created new Terminal location', {
      locationId: newLocation.id,
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
    });

    return c.json({
      locationId: newLocation.id,
      displayName: newLocation.display_name,
    });
  } catch (error: any) {
    logger.error('Error getting/creating Terminal location', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'No connected account found') {
      return c.json({ error: 'No connected account found' }, 404);
    }
    if (error.message === 'Payments are not enabled for this account') {
      return c.json({ error: 'Payments are not enabled for this account' }, 403);
    }

    return c.json({ error: 'Failed to get/create Terminal location' }, 500);
  }
});

// ============================================
// POST /stripe/terminal/connection-token - Get a connection token for Stripe Terminal SDK
// ============================================
const connectionTokenRoute = createRoute({
  method: 'post',
  path: '/stripe/terminal/connection-token',
  summary: 'Get a connection token for Stripe Terminal SDK',
  description: 'Returns a connection token that the mobile app uses to connect to Stripe Terminal',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            location: z.string().optional(),
          }).optional(),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Connection token generated successfully',
      content: {
        'application/json': {
          schema: z.object({
            secret: z.string(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Payments not enabled for this account' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(connectionTokenRoute, async (c) => {
  try {
    const { connectedAccount } = await getConnectedAccount(c.req.header('Authorization'));

    const body = await c.req.json().catch(() => ({}));

    // Create connection token using the connected account
    const connectionToken = await stripe.terminal.connectionTokens.create(
      {
        location: body.location,
      },
      {
        stripeAccount: connectedAccount.stripe_account_id,
      }
    );

    logger.info('Terminal connection token created', {
      accountId: connectedAccount.stripe_account_id,
    });

    return c.json({
      secret: connectionToken.secret,
    });
  } catch (error: any) {
    logger.error('Error creating connection token', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'No connected account found') {
      return c.json({ error: 'No connected account found' }, 404);
    }
    if (error.message === 'Payments are not enabled for this account') {
      return c.json({ error: 'Payments are not enabled for this account' }, 403);
    }

    return c.json({ error: 'Failed to create connection token' }, 500);
  }
});

// ============================================
// POST /stripe/terminal/payment-intent - Create a payment intent for terminal payment
// ============================================
const createPaymentIntentRoute = createRoute({
  method: 'post',
  path: '/stripe/terminal/payment-intent',
  summary: 'Create a payment intent for terminal/tap-to-pay or manual card payment',
  description: 'Creates a PaymentIntent configured for card_present (Tap to Pay) or card (manual entry) payments',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive().describe('Amount in dollars'),
            currency: z.string().length(3).optional(),
            description: z.string().optional(),
            metadata: z.record(z.string()).optional(),
            receiptEmail: z.preprocess(
              (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
              z.string().email().optional()
            ),
            captureMethod: z.enum(['automatic', 'manual']).optional().default('automatic').describe('Capture method for the payment'),
            paymentMethodType: z.enum(['card_present', 'card']).optional().default('card_present').describe('Payment method type: card_present for Tap to Pay, card for manual entry'),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Payment intent created successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            clientSecret: z.string(),
            amount: z.number(),
            currency: z.string(),
            status: z.string(),
            stripeAccountId: z.string(),
          }),
        },
      },
    },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthorized' },
    403: { description: 'Payments not enabled for this account' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(createPaymentIntentRoute, async (c) => {
  try {
    const { connectedAccount, payload, subscriptionTier, orgCurrency } = await getConnectedAccount(c.req.header('Authorization'));
    const body = await c.req.json();

    const currency = body.currency || orgCurrency;

    // Validate amount
    if (!body.amount || body.amount < 0.50) {
      return c.json({ error: `Amount must be at least ${formatCurrencyUtil(0.50, currency)}` }, 400);
    }

    // Convert to smallest currency unit (cents for USD, yen for JPY, etc.)
    const amountInCents = toSmallestUnit(body.amount, currency);

    // Calculate platform fee based on subscription tier
    const platformFee = calculatePlatformFee(amountInCents, subscriptionTier);

    // Determine payment method type and capture method
    const paymentMethodType = body.paymentMethodType || 'card_present';
    const captureMethod = body.captureMethod || 'automatic';
    const isManualCardEntry = paymentMethodType === 'card';

    // Look up catalogId from order if orderId is provided in metadata
    let catalogId: string | null = null;
    if (body.metadata?.orderId) {
      const orderRows = await query<{ catalog_id: string | null }>(
        'SELECT catalog_id FROM orders WHERE id = $1 AND organization_id = $2',
        [body.metadata.orderId, payload.organizationId]
      );
      if (orderRows.length > 0) {
        catalogId = orderRows[0].catalog_id;
      }
    }

    let paymentIntent;

    if (isManualCardEntry) {
      // For manual card entry, use DIRECT CHARGES (created on connected account)
      // The mobile app passes stripeAccountId to StripeProvider to confirm on connected account
      // Note: Manual card entry has higher Stripe fees (2.9% + 30¢ vs 2.7% + 5¢ for Tap to Pay)
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: amountInCents,
          currency,
          payment_method_types: ['card'],
          capture_method: captureMethod,
          description: body.description || 'Manual card payment',
          receipt_email: body.receiptEmail,
          application_fee_amount: platformFee > 0 ? platformFee : undefined,
          metadata: {
            ...body.metadata,
            organization_id: payload.organizationId,
            user_id: payload.userId,
            source: 'mobile_app',
            subscription_tier: subscriptionTier,
            platform_fee_cents: platformFee.toString(),
            payment_method_type: paymentMethodType,
            ...(catalogId && { catalogId }),
          },
        },
        {
          stripeAccount: connectedAccount.stripe_account_id,
        }
      );
    } else {
      // For Tap to Pay (card_present), use DIRECT CHARGES (created on connected account)
      // This is required because the terminal reader is registered to the connected account
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: amountInCents,
          currency,
          payment_method_types: ['card_present'],
          capture_method: captureMethod,
          description: body.description || 'Tap to Pay payment',
          receipt_email: body.receiptEmail,
          application_fee_amount: platformFee > 0 ? platformFee : undefined,
          metadata: {
            ...body.metadata,
            organization_id: payload.organizationId,
            user_id: payload.userId,
            source: 'mobile_app',
            subscription_tier: subscriptionTier,
            platform_fee_cents: platformFee.toString(),
            payment_method_type: paymentMethodType,
            ...(catalogId && { catalogId }),
          },
        },
        {
          stripeAccount: connectedAccount.stripe_account_id,
        }
      );
    }

    logger.info('[TERMINAL DEBUG] ========== Payment Intent Created ==========', {
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret ? 'present' : 'missing',
      amount: body.amount,
      amountInCents: paymentIntent.amount,
      platformFee,
      subscriptionTier,
      paymentMethodType,
      captureMethod,
      isManualCardEntry: paymentMethodType === 'card',
      chargeType: 'DIRECT (connected account)',
      connectedAccountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      metadata: paymentIntent.metadata,
    });
    logger.info('[TERMINAL DEBUG] Webhook that should receive payment_intent.succeeded:', {
      expectedWebhook: '/stripe/webhook-connect (connect)',
    });

    return c.json({
      id: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: paymentIntent.status,
      stripeAccountId: connectedAccount.stripe_account_id,
    });
  } catch (error: any) {
    logger.error('Error creating terminal payment intent', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'No connected account found') {
      return c.json({ error: 'No connected account found' }, 404);
    }
    if (error.message === 'Payments are not enabled for this account') {
      return c.json({ error: 'Payments are not enabled for this account' }, 403);
    }
    if (error.type === 'StripeInvalidRequestError') {
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to create payment intent' }, 500);
  }
});

// ============================================
// POST /stripe/terminal/payment-intent/:id/capture - Capture a payment intent
// ============================================
const capturePaymentIntentRoute = createRoute({
  method: 'post',
  path: '/stripe/terminal/payment-intent/{paymentIntentId}/capture',
  summary: 'Capture a terminal payment intent',
  description: 'Captures a payment intent that was collected via terminal (for manual capture mode)',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      paymentIntentId: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Payment intent captured successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            status: z.string(),
            amount: z.number(),
          }),
        },
      },
    },
    400: { description: 'Payment cannot be captured' },
    401: { description: 'Unauthorized' },
    404: { description: 'Payment intent not found' },
  },
});

app.openapi(capturePaymentIntentRoute, async (c) => {
  try {
    const { paymentIntentId } = c.req.param();
    const { connectedAccount } = await getConnectedAccount(c.req.header('Authorization'));

    const paymentIntent = await stripe.paymentIntents.capture(
      paymentIntentId,
      {},
      {
        stripeAccount: connectedAccount.stripe_account_id,
      }
    );

    logger.info('Terminal payment intent captured', {
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      accountId: connectedAccount.stripe_account_id,
    });

    return c.json({
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
    });
  } catch (error: any) {
    logger.error('Error capturing payment intent', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      if (error.message?.includes('No such payment_intent')) {
        return c.json({ error: 'Payment intent not found' }, 404);
      }
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to capture payment intent' }, 500);
  }
});

// ============================================
// POST /stripe/terminal/payment-intent/:id/cancel - Cancel a payment intent
// ============================================
const cancelPaymentIntentRoute = createRoute({
  method: 'post',
  path: '/stripe/terminal/payment-intent/{paymentIntentId}/cancel',
  summary: 'Cancel a terminal payment intent',
  description: 'Cancels a payment intent that has not yet been captured',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      paymentIntentId: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Payment intent cancelled successfully',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            id: z.string(),
            status: z.string(),
          }),
        },
      },
    },
    400: { description: 'Payment cannot be cancelled' },
    401: { description: 'Unauthorized' },
    404: { description: 'Payment intent not found' },
  },
});

app.openapi(cancelPaymentIntentRoute, async (c) => {
  try {
    const { paymentIntentId } = c.req.param();
    const { connectedAccount } = await getConnectedAccount(c.req.header('Authorization'));

    const paymentIntent = await stripe.paymentIntents.cancel(
      paymentIntentId,
      {},
      {
        stripeAccount: connectedAccount.stripe_account_id,
      }
    );

    logger.info('Terminal payment intent cancelled', {
      paymentIntentId: paymentIntent.id,
      accountId: connectedAccount.stripe_account_id,
    });

    return c.json({
      success: true,
      id: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (error: any) {
    logger.error('Error cancelling payment intent', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      if (error.message?.includes('No such payment_intent')) {
        return c.json({ error: 'Payment intent not found' }, 404);
      }
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to cancel payment intent' }, 500);
  }
});

// ============================================
// GET /stripe/terminal/payment-intent/:id - Get payment intent status
// ============================================
const getPaymentIntentRoute = createRoute({
  method: 'get',
  path: '/stripe/terminal/payment-intent/{paymentIntentId}',
  summary: 'Get terminal payment intent status',
  description: 'Retrieves the current status of a payment intent',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      paymentIntentId: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Payment intent retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            clientSecret: z.string().nullable(),
            amount: z.number(),
            currency: z.string(),
            status: z.string(),
            receiptUrl: z.string().nullable(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Payment intent not found' },
  },
});

app.openapi(getPaymentIntentRoute, async (c) => {
  try {
    const { paymentIntentId } = c.req.param();
    const { connectedAccount } = await getConnectedAccount(c.req.header('Authorization'));

    const paymentIntent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      {
        expand: ['latest_charge'],
      },
      {
        stripeAccount: connectedAccount.stripe_account_id,
      }
    );

    // Get receipt URL from the charge if available
    let receiptUrl = null;
    if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object') {
      receiptUrl = paymentIntent.latest_charge.receipt_url;
    }

    return c.json({
      id: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: paymentIntent.status,
      receiptUrl,
    });
  } catch (error: any) {
    logger.error('Error retrieving payment intent', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      return c.json({ error: 'Payment intent not found' }, 404);
    }

    return c.json({ error: 'Failed to retrieve payment intent' }, 500);
  }
});

// ============================================
// POST /stripe/terminal/payment-intent/:id/send-receipt - Send receipt email
// ============================================
const sendReceiptRoute = createRoute({
  method: 'post',
  path: '/stripe/terminal/payment-intent/{paymentIntentId}/send-receipt',
  summary: 'Send receipt email for a completed payment',
  description: 'Sends a Stripe receipt email to the specified email address for a completed payment',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      paymentIntentId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Receipt sent successfully',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            receiptUrl: z.string().nullable(),
          }),
        },
      },
    },
    400: { description: 'Invalid request or payment not completed' },
    401: { description: 'Unauthorized' },
    404: { description: 'Payment intent not found' },
  },
});

app.openapi(sendReceiptRoute, async (c) => {
  try {
    const { paymentIntentId } = c.req.param();
    const { connectedAccount, payload } = await getConnectedAccount(c.req.header('Authorization'));
    const { email } = await c.req.json();

    // Get the payment intent with the charge
    const paymentIntent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      {
        expand: ['latest_charge'],
      },
      {
        stripeAccount: connectedAccount.stripe_account_id,
      }
    );

    if (paymentIntent.status !== 'succeeded') {
      return c.json({ error: 'Payment must be completed before sending receipt' }, 400);
    }

    // Get the charge from the payment intent (already expanded)
    if (!paymentIntent.latest_charge) {
      return c.json({ error: 'No charge found for this payment' }, 400);
    }

    // Get charge details - it's already expanded so it's an object
    const charge = typeof paymentIntent.latest_charge === 'object'
      ? paymentIntent.latest_charge
      : await stripe.charges.retrieve(
          paymentIntent.latest_charge,
          { stripeAccount: connectedAccount.stripe_account_id }
        );

    const receiptUrl = charge.receipt_url || null;

    // Extract card details from the charge
    const paymentMethodDetails = charge.payment_method_details;
    let cardBrand: string | undefined;
    let cardLast4: string | undefined;

    if (paymentMethodDetails?.type === 'card_present' && paymentMethodDetails.card_present) {
      cardBrand = paymentMethodDetails.card_present.brand || undefined;
      cardLast4 = paymentMethodDetails.card_present.last4 || undefined;
    } else if (paymentMethodDetails?.type === 'card' && paymentMethodDetails.card) {
      cardBrand = paymentMethodDetails.card.brand || undefined;
      cardLast4 = paymentMethodDetails.card.last4 || undefined;
    }

    // Get organization name for merchant name
    const orgRows = await query<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [payload.organizationId]
    );
    const merchantName = orgRows[0]?.name || undefined;

    // Send receipt via our email service (works in test mode!)
    await emailService.sendReceipt(email, {
      amount: paymentIntent.amount,
      orderNumber: paymentIntent.metadata?.orderNumber || undefined,
      cardBrand,
      cardLast4,
      date: new Date(charge.created * 1000),
      receiptUrl: receiptUrl || undefined,
      merchantName,
    }, paymentIntent.currency || connectedAccount?.default_currency || 'usd');

    // Also save/update customer in our database
    // NOTE: We do NOT increment total_orders/total_spent here because that was already
    // done when the order was created in orders.ts. This only ensures the customer
    // record exists and updates their email linkage if needed.
    try {
      const catalogId = paymentIntent.metadata?.catalogId || null;
      const orderId = paymentIntent.metadata?.orderId || null;

      // Only create customer record if it doesn't exist, don't update stats
      await query(
        `INSERT INTO customers (organization_id, catalog_id, email, total_orders, total_spent, last_order_at)
         VALUES ($1, $2, $3, 0, 0, NOW())
         ON CONFLICT (organization_id, COALESCE(catalog_id, '00000000-0000-0000-0000-000000000000'::uuid), email)
         DO UPDATE SET
           last_order_at = NOW(),
           updated_at = NOW()`,
        [
          payload.organizationId,
          catalogId,
          email.toLowerCase(),
        ]
      );

      // If we have an orderId, update the order's customer_email and link customer
      if (orderId) {
        await query(
          `UPDATE orders SET customer_email = $1, updated_at = NOW() WHERE id = $2`,
          [email.toLowerCase(), orderId]
        );
      }

      logger.info('Customer saved/updated for receipt', {
        email: email.toLowerCase(),
        organizationId: payload.organizationId,
        catalogId,
        orderId,
      });
    } catch (dbError) {
      // Log but don't fail the request
      logger.error('Failed to save customer email', { error: dbError, email });
    }

    logger.info('Receipt email sent via SES', {
      paymentIntentId,
      email,
      accountId: connectedAccount.stripe_account_id,
      receiptUrl,
    });

    return c.json({
      success: true,
      receiptUrl,
    });
  } catch (error: any) {
    logger.error('Error sending receipt', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      if (error.message?.includes('No such payment_intent') || error.message?.includes('No such charge')) {
        return c.json({ error: 'Payment not found' }, 404);
      }
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to send receipt' }, 500);
  }
});

// ============================================
// POST /stripe/terminal/payment-intent/:id/simulate - Simulate payment for testing
// ============================================
const simulatePaymentRoute = createRoute({
  method: 'post',
  path: '/stripe/terminal/payment-intent/{paymentIntentId}/simulate',
  summary: 'Simulate a terminal payment for testing (test mode only)',
  description: 'Confirms a payment intent with a test card for browser/dev testing. Only works in Stripe test mode.',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      paymentIntentId: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Payment simulated successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            status: z.string(),
            amount: z.number(),
            receiptUrl: z.string().nullable(),
          }),
        },
      },
    },
    400: { description: 'Simulation failed or not in test mode' },
    401: { description: 'Unauthorized' },
    404: { description: 'Payment intent not found' },
  },
});

app.openapi(simulatePaymentRoute, async (c) => {
  try {
    const { paymentIntentId } = c.req.param();
    const { connectedAccount, subscriptionTier } = await getConnectedAccount(c.req.header('Authorization'));

    // First, check if we're in test mode
    const paymentIntent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      {},
      { stripeAccount: connectedAccount.stripe_account_id }
    );

    if (!paymentIntent.id.startsWith('pi_') || paymentIntent.livemode) {
      return c.json({ error: 'Simulation only works in Stripe test mode' }, 400);
    }

    if (paymentIntent.status === 'succeeded') {
      return c.json({
        id: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        receiptUrl: null,
      });
    }

    // For card_present payment intents, we need to use test helpers
    // First, create a simulated reader if needed and present a test card
    try {
      // Use Stripe Test Helpers to simulate the terminal payment
      // This requires using the testHelpers API
      const testHelpers = (stripe as any).testHelpers;

      if (testHelpers?.terminal?.readers) {
        // Get or create a simulated reader
        const readers = await stripe.terminal.readers.list(
          { limit: 1, status: 'online' },
          { stripeAccount: connectedAccount.stripe_account_id }
        );

        let readerId: string;

        if (readers.data.length > 0) {
          readerId = readers.data[0].id;
        } else {
          // Create a simulated reader
          const location = await stripe.terminal.locations.create(
            {
              display_name: 'Test Location',
              address: {
                line1: '123 Test St',
                city: 'San Francisco',
                state: 'CA',
                postal_code: '94111',
                country: 'US',
              },
            },
            { stripeAccount: connectedAccount.stripe_account_id }
          );

          const reader = await stripe.terminal.readers.create(
            {
              registration_code: 'simulated-wpe',
              label: 'Simulated Reader',
              location: location.id,
            },
            { stripeAccount: connectedAccount.stripe_account_id }
          );
          readerId = reader.id;
        }

        // Present a test payment method
        await testHelpers.terminal.readers.presentPaymentMethod(
          readerId,
          {},
          { stripeAccount: connectedAccount.stripe_account_id }
        );
      }
    } catch (testHelperError: any) {
      // Test helpers might not be available, fall back to direct confirmation
      logger.warn('Test helpers not available, using fallback', { error: testHelperError.message });
    }

    // Try to confirm the payment intent directly for simulation
    // For card_present, we'll update it to use a regular card for testing
    try {
      // Cancel the card_present intent and create a new one with card type
      await stripe.paymentIntents.cancel(
        paymentIntentId,
        {},
        { stripeAccount: connectedAccount.stripe_account_id }
      );

      // Calculate platform fee based on subscription tier
      const platformFee = calculatePlatformFee(paymentIntent.amount, subscriptionTier);

      // Create a new payment intent with card payment method
      const newPaymentIntent = await stripe.paymentIntents.create(
        {
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          payment_method_types: ['card'], // Explicitly use card only
          payment_method: 'pm_card_visa', // Stripe's test Visa card
          confirm: true,
          description: paymentIntent.description || 'Simulated payment',
          receipt_email: paymentIntent.receipt_email || undefined, // Only pass if non-empty
          application_fee_amount: platformFee > 0 ? platformFee : undefined,
          metadata: {
            ...paymentIntent.metadata,
            simulated: 'true',
            original_payment_intent: paymentIntentId,
            subscription_tier: subscriptionTier,
            platform_fee_cents: platformFee.toString(),
          },
        },
        { stripeAccount: connectedAccount.stripe_account_id }
      );

      // Get the receipt URL
      let receiptUrl = null;
      if (newPaymentIntent.latest_charge) {
        const charge = await stripe.charges.retrieve(
          newPaymentIntent.latest_charge as string,
          {},
          { stripeAccount: connectedAccount.stripe_account_id }
        );
        receiptUrl = charge.receipt_url;
      }

      // Update the order to reference the new payment intent ID and mark as completed
      // The original order was linked to paymentIntentId, now we need to update it
      const orderId = paymentIntent.metadata?.orderId;
      if (orderId) {
        await query(
          `UPDATE orders
           SET stripe_payment_intent_id = $1,
               stripe_charge_id = $2,
               status = 'completed',
               updated_at = NOW()
           WHERE id = $3`,
          [newPaymentIntent.id, newPaymentIntent.latest_charge || null, orderId]
        );
        logger.info('Order updated with simulated payment', {
          orderId,
          newPaymentIntentId: newPaymentIntent.id,
          chargeId: newPaymentIntent.latest_charge,
        });
      }

      logger.info('Payment simulated successfully', {
        originalPaymentIntentId: paymentIntentId,
        newPaymentIntentId: newPaymentIntent.id,
        amount: newPaymentIntent.amount,
        platformFee,
        subscriptionTier,
        accountId: connectedAccount.stripe_account_id,
        orderId: orderId || null,
      });

      return c.json({
        id: newPaymentIntent.id,
        status: newPaymentIntent.status,
        amount: newPaymentIntent.amount,
        receiptUrl,
      });
    } catch (confirmError: any) {
      logger.error('Failed to simulate payment', { error: confirmError.message });
      return c.json({ error: `Simulation failed: ${confirmError.message}` }, 400);
    }
  } catch (error: any) {
    logger.error('Error simulating payment', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      if (error.message?.includes('No such payment_intent')) {
        return c.json({ error: 'Payment intent not found' }, 404);
      }
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to simulate payment' }, 500);
  }
});

// ============================================
// GET /stripe/terminal/readers - List registered terminal readers
// ============================================
const listReadersRoute = createRoute({
  method: 'get',
  path: '/stripe/terminal/readers',
  summary: 'List registered terminal readers',
  description: 'Returns all terminal readers registered to the connected Stripe account',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Readers retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            readers: z.array(z.object({
              id: z.string(),
              label: z.string().nullable(),
              deviceType: z.string(),
              status: z.string().nullable(),
              ipAddress: z.string().nullable(),
              locationId: z.string().nullable(),
              serialNumber: z.string().nullable(),
            })),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Payments not enabled for this account' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(listReadersRoute, async (c) => {
  try {
    const { connectedAccount } = await getConnectedAccount(c.req.header('Authorization'));

    const readers = await stripe.terminal.readers.list(
      { limit: 100 },
      { stripeAccount: connectedAccount.stripe_account_id }
    );

    logger.info('Terminal readers listed', {
      accountId: connectedAccount.stripe_account_id,
      count: readers.data.length,
    });

    return c.json({
      readers: readers.data.map((reader) => ({
        id: reader.id,
        label: reader.label || null,
        deviceType: reader.device_type || 'unknown',
        status: reader.status || null,
        ipAddress: reader.ip_address || null,
        locationId: reader.location ? (typeof reader.location === 'string' ? reader.location : reader.location.id) : null,
        serialNumber: reader.serial_number || null,
      })),
    });
  } catch (error: any) {
    logger.error('Error listing terminal readers', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'No connected account found') {
      return c.json({ error: 'No connected account found' }, 404);
    }
    if (error.message === 'Payments are not enabled for this account') {
      return c.json({ error: 'Payments are not enabled for this account' }, 403);
    }

    return c.json({ error: 'Failed to list terminal readers' }, 500);
  }
});

// ============================================
// POST /stripe/terminal/readers - Register a new terminal reader
// ============================================
const registerReaderRoute = createRoute({
  method: 'post',
  path: '/stripe/terminal/readers',
  summary: 'Register a new terminal reader',
  description: 'Registers a physical terminal reader using the registration code displayed on the device',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            registrationCode: z.string().min(1).describe('Registration code from the reader device'),
            label: z.string().optional().describe('Human-readable label for the reader'),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Reader registered successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            label: z.string().nullable(),
            deviceType: z.string(),
            status: z.string().nullable(),
            locationId: z.string().nullable(),
          }),
        },
      },
    },
    400: { description: 'Invalid registration code' },
    401: { description: 'Unauthorized' },
    403: { description: 'Payments not enabled for this account' },
    404: { description: 'No connected account found' },
  },
});

app.openapi(registerReaderRoute, async (c) => {
  try {
    const { connectedAccount, payload } = await getConnectedAccount(c.req.header('Authorization'));
    const body = await c.req.json();

    // Get or create a terminal location for this account
    let locationId: string;
    const existingLocations = await stripe.terminal.locations.list(
      { limit: 1 },
      { stripeAccount: connectedAccount.stripe_account_id }
    );

    if (existingLocations.data.length > 0) {
      locationId = existingLocations.data[0].id;
    } else {
      const orgRows = await query<{ name: string }>(
        'SELECT name FROM organizations WHERE id = $1',
        [payload.organizationId]
      );
      const orgName = orgRows.length > 0 ? orgRows[0].name : 'Mobile POS';

      const newLocation = await stripe.terminal.locations.create(
        {
          display_name: `${orgName} - Terminal`,
          address: {
            line1: '123 Main St',
            city: 'San Francisco',
            state: 'CA',
            postal_code: '94111',
            country: 'US',
          },
        },
        { stripeAccount: connectedAccount.stripe_account_id }
      );
      locationId = newLocation.id;
    }

    const reader = await stripe.terminal.readers.create(
      {
        registration_code: body.registrationCode,
        label: body.label || 'Terminal Reader',
        location: locationId,
      },
      { stripeAccount: connectedAccount.stripe_account_id }
    );

    logger.info('Terminal reader registered', {
      readerId: reader.id,
      label: reader.label,
      deviceType: reader.device_type,
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
    });

    return c.json({
      id: reader.id,
      label: reader.label || null,
      deviceType: reader.device_type || 'unknown',
      status: reader.status || null,
      locationId,
    });
  } catch (error: any) {
    logger.error('Error registering terminal reader', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'No connected account found') {
      return c.json({ error: 'No connected account found' }, 404);
    }
    if (error.message === 'Payments are not enabled for this account') {
      return c.json({ error: 'Payments are not enabled for this account' }, 403);
    }
    if (error.type === 'StripeInvalidRequestError') {
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to register terminal reader' }, 500);
  }
});

// ============================================
// DELETE /stripe/terminal/readers/:readerId - Delete/deregister a terminal reader
// ============================================
const deleteReaderRoute = createRoute({
  method: 'delete',
  path: '/stripe/terminal/readers/{readerId}',
  summary: 'Delete a terminal reader',
  description: 'Deregisters a physical terminal reader from the connected Stripe account',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      readerId: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Reader deleted successfully',
      content: {
        'application/json': {
          schema: z.object({
            deleted: z.boolean(),
            id: z.string(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Payments not enabled for this account' },
    404: { description: 'Reader not found' },
  },
});

app.openapi(deleteReaderRoute, async (c) => {
  try {
    const { readerId } = c.req.param();
    const { connectedAccount } = await getConnectedAccount(c.req.header('Authorization'));

    const result = await stripe.terminal.readers.del(
      readerId,
      { stripeAccount: connectedAccount.stripe_account_id }
    );

    logger.info('Terminal reader deleted', {
      readerId,
      accountId: connectedAccount.stripe_account_id,
    });

    return c.json({
      deleted: result.deleted,
      id: result.id,
    });
  } catch (error: any) {
    logger.error('Error deleting terminal reader', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'No connected account found') {
      return c.json({ error: 'No connected account found' }, 404);
    }
    if (error.message === 'Payments are not enabled for this account') {
      return c.json({ error: 'Payments are not enabled for this account' }, 403);
    }
    if (error.type === 'StripeInvalidRequestError') {
      if (error.message?.includes('No such terminal.reader')) {
        return c.json({ error: 'Reader not found' }, 404);
      }
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to delete terminal reader' }, 500);
  }
});

// ============================================
// POST /stripe/terminal/readers/:readerId/process-payment - Server-driven payment on a physical reader
// ============================================
const processReaderPaymentRoute = createRoute({
  method: 'post',
  path: '/stripe/terminal/readers/{readerId}/process-payment',
  summary: 'Process payment on a physical terminal reader (server-driven)',
  description: 'Sends a payment to a physical terminal reader. Either provide an existing paymentIntentId (from the mobile app checkout flow) or an amount to create a new PaymentIntent (vendor dashboard flow).',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      readerId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            paymentIntentId: z.string().optional().describe('Existing PaymentIntent ID to send to reader (skips PI creation)'),
            amount: z.number().positive().optional().describe('Amount in dollars (creates new PI)'),
            currency: z.string().length(3).optional(),
            description: z.string().optional(),
            metadata: z.record(z.string()).optional(),
            customerEmail: z.preprocess(
              (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
              z.string().email().optional()
            ),
          }).refine(data => data.paymentIntentId || data.amount, {
            message: 'Either paymentIntentId or amount is required',
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Payment sent to reader successfully',
      content: {
        'application/json': {
          schema: z.object({
            paymentIntentId: z.string(),
            readerId: z.string(),
            readerLabel: z.string().nullable(),
            actionStatus: z.string(),
          }),
        },
      },
    },
    400: { description: 'Invalid request or reader not ready' },
    401: { description: 'Unauthorized' },
    403: { description: 'Payments not enabled for this account' },
    404: { description: 'Reader or connected account not found' },
  },
});

app.openapi(processReaderPaymentRoute, async (c) => {
  try {
    const { readerId } = c.req.param();
    const { connectedAccount, payload, subscriptionTier, orgCurrency } = await getConnectedAccount(c.req.header('Authorization'));
    const body = await c.req.json();

    if (!body.paymentIntentId && !body.amount) {
      return c.json({ error: 'Either paymentIntentId or amount is required' }, 400);
    }

    const currency = body.currency || orgCurrency;
    let paymentIntentId: string;

    if (body.paymentIntentId) {
      // Mode A: Use an existing PaymentIntent (from mobile app checkout flow)
      paymentIntentId = body.paymentIntentId;
      logger.info('Terminal reader: using existing PaymentIntent', {
        readerId,
        paymentIntentId,
        organizationId: payload.organizationId,
      });
    } else {
      // Mode B: Create a new PaymentIntent (vendor dashboard flow)
      if (body.amount < 0.50) {
        return c.json({ error: `Amount must be at least ${formatCurrencyUtil(0.50, currency)}` }, 400);
      }

      const amountInCents = toSmallestUnit(body.amount, currency);
      const platformFee = calculatePlatformFee(amountInCents, subscriptionTier);

      const paymentIntent = await stripe.paymentIntents.create(
        {
          amount: amountInCents,
          currency,
          payment_method_types: ['card_present'],
          capture_method: 'automatic',
          description: body.description || 'Terminal reader payment',
          receipt_email: body.customerEmail,
          application_fee_amount: platformFee > 0 ? platformFee : undefined,
          metadata: {
            ...body.metadata,
            organization_id: payload.organizationId,
            user_id: payload.userId,
            source: 'vendor_dashboard',
            subscription_tier: subscriptionTier,
            platform_fee_cents: platformFee.toString(),
            payment_method_type: 'card_present',
            reader_id: readerId,
          },
        },
        { stripeAccount: connectedAccount.stripe_account_id }
      );

      paymentIntentId = paymentIntent.id;
    }

    // Send the PaymentIntent to the reader for processing
    const reader = await stripe.terminal.readers.processPaymentIntent(
      readerId,
      { payment_intent: paymentIntentId },
      { stripeAccount: connectedAccount.stripe_account_id }
    );

    logger.info('Terminal reader payment initiated', {
      readerId,
      readerLabel: reader.label,
      paymentIntentId,
      amount: body.amount,
      existingPI: !!body.paymentIntentId,
      subscriptionTier,
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
      actionStatus: reader.action?.status,
    });

    return c.json({
      paymentIntentId,
      readerId: reader.id,
      readerLabel: reader.label || null,
      actionStatus: reader.action?.status || 'in_progress',
    });
  } catch (error: any) {
    logger.error('Error processing reader payment', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'No connected account found') {
      return c.json({ error: 'No connected account found' }, 404);
    }
    if (error.message === 'Payments are not enabled for this account') {
      return c.json({ error: 'Payments are not enabled for this account' }, 403);
    }
    if (error.type === 'StripeInvalidRequestError') {
      if (error.message?.includes('No such terminal.reader')) {
        return c.json({ error: 'Reader not found' }, 404);
      }
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to process reader payment' }, 500);
  }
});

// ============================================
// POST /stripe/terminal/readers/:readerId/cancel-action - Cancel pending action on a reader
// ============================================
const cancelReaderActionRoute = createRoute({
  method: 'post',
  path: '/stripe/terminal/readers/{readerId}/cancel-action',
  summary: 'Cancel the current action on a terminal reader',
  description: 'Cancels any pending payment collection on the reader',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      readerId: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Action cancelled successfully',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            readerId: z.string(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Reader not found' },
  },
});

app.openapi(cancelReaderActionRoute, async (c) => {
  try {
    const { readerId } = c.req.param();
    const { connectedAccount } = await getConnectedAccount(c.req.header('Authorization'));

    await stripe.terminal.readers.cancelAction(
      readerId,
      { stripeAccount: connectedAccount.stripe_account_id }
    );

    logger.info('Terminal reader action cancelled', {
      readerId,
      accountId: connectedAccount.stripe_account_id,
    });

    return c.json({
      success: true,
      readerId,
    });
  } catch (error: any) {
    logger.error('Error cancelling reader action', { error: error.message });

    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.type === 'StripeInvalidRequestError') {
      if (error.message?.includes('No such terminal.reader')) {
        return c.json({ error: 'Reader not found' }, 404);
      }
      return c.json({ error: error.message }, 400);
    }

    return c.json({ error: 'Failed to cancel reader action' }, 500);
  }
});

export default app;
