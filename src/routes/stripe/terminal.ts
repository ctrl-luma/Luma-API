import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../../db';
import { StripeConnectedAccount } from '../../db/models';
import { stripe } from '../../services/stripe';
import { logger } from '../../utils/logger';

const app = new OpenAPIHono();

// Helper to verify auth and get connected account
async function getConnectedAccount(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }

  const token = authHeader.substring(7);
  const { authService } = await import('../../services/auth');
  const payload = await authService.verifyToken(token);

  const rows = await query<StripeConnectedAccount>(
    'SELECT * FROM stripe_connected_accounts WHERE organization_id = $1',
    [payload.organizationId]
  );

  if (rows.length === 0) {
    throw new Error('No connected account found');
  }

  const connectedAccount = rows[0];

  if (!connectedAccount.charges_enabled) {
    throw new Error('Payments are not enabled for this account');
  }

  return { connectedAccount, payload };
}

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
  summary: 'Create a payment intent for terminal/tap-to-pay payment',
  description: 'Creates a PaymentIntent configured for card_present payments via Stripe Terminal',
  tags: ['Stripe Terminal'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive().describe('Amount in dollars'),
            currency: z.string().length(3).optional().default('usd'),
            description: z.string().optional(),
            metadata: z.record(z.string()).optional(),
            receiptEmail: z.string().email().optional(),
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
    const { connectedAccount, payload } = await getConnectedAccount(c.req.header('Authorization'));
    const body = await c.req.json();

    // Validate amount
    if (!body.amount || body.amount < 0.50) {
      return c.json({ error: 'Amount must be at least $0.50' }, 400);
    }

    // Convert to cents
    const amountInCents = Math.round(body.amount * 100);

    // Create payment intent for the connected account
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountInCents,
        currency: body.currency || 'usd',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: body.description || 'Tap to Pay payment',
        receipt_email: body.receiptEmail,
        metadata: {
          ...body.metadata,
          organization_id: payload.organizationId,
          user_id: payload.userId,
          source: 'mobile_app',
        },
      },
      {
        stripeAccount: connectedAccount.stripe_account_id,
      }
    );

    logger.info('Terminal payment intent created', {
      paymentIntentId: paymentIntent.id,
      amount: body.amount,
      accountId: connectedAccount.stripe_account_id,
      organizationId: payload.organizationId,
    });

    return c.json({
      id: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: paymentIntent.status,
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

export default app;
