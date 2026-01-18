import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query, transaction } from '../db';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';

const app = new OpenAPIHono();

// Schema definitions
const orderItemSchema = z.object({
  productId: z.string().uuid(),
  catalogProductId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().int(), // in cents
});

const orderSchema = z.object({
  id: z.string().uuid(),
  orderNumber: z.string(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded']),
  paymentMethod: z.enum(['card', 'cash', 'tap_to_pay']).nullable(),
  subtotal: z.number(),
  taxAmount: z.number(),
  tipAmount: z.number(),
  totalAmount: z.number(),
  stripePaymentIntentId: z.string().nullable(),
  customerEmail: z.string().nullable(),
  customerId: z.string().uuid().nullable(),
  catalogId: z.string().uuid().nullable(),
  items: z.array(z.object({
    id: z.string().uuid(),
    productId: z.string().uuid().nullable(),
    categoryId: z.string().uuid().nullable(),
    name: z.string(),
    quantity: z.number(),
    unitPrice: z.number(),
  })).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createOrderSchema = z.object({
  catalogId: z.string().uuid().optional(),
  items: z.array(orderItemSchema).optional(), // Optional for quick charge
  subtotal: z.number().int(), // in cents
  taxAmount: z.number().int().optional().default(0),
  tipAmount: z.number().int().optional().default(0),
  totalAmount: z.number().int(), // in cents
  paymentMethod: z.enum(['card', 'cash', 'tap_to_pay']).optional().default('tap_to_pay'),
  customerEmail: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().email().optional()
  ),
  stripePaymentIntentId: z.string().optional(),
  isQuickCharge: z.boolean().optional().default(false),
  description: z.string().optional(),
});

// Helper to verify token and get user info
async function verifyAuth(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = authHeader.substring(7);
  const { authService } = await import('../services/auth');
  return authService.verifyToken(token);
}

// Generate order number (e.g., ORD-20231225-001)
function generateOrderNumber(): string {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `ORD-${dateStr}-${random}`;
}

// Create order
const createOrderRoute = createRoute({
  method: 'post',
  path: '/orders',
  summary: 'Create a new order',
  description: 'Creates an order record, optionally with line items. Call this before creating a Stripe PaymentIntent.',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: createOrderSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Order created',
      content: {
        'application/json': {
          schema: orderSchema,
        },
      },
    },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(createOrderRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    const orderNumber = generateOrderNumber();
    const subtotal = body.subtotal / 100; // Convert cents to dollars for DB
    const taxAmount = (body.taxAmount || 0) / 100;
    const tipAmount = (body.tipAmount || 0) / 100;
    const totalAmount = body.totalAmount / 100;
    const customerEmail = body.customerEmail?.toLowerCase().trim() || null;

    const result = await transaction(async (client) => {
      let customerId: string | null = null;

      // Create or update customer record if email is provided
      if (customerEmail) {
        const customerResult = await client.query(
          `INSERT INTO customers (organization_id, catalog_id, email, total_orders, total_spent, last_order_at)
           VALUES ($1, $2, $3, 1, $4, NOW())
           ON CONFLICT (organization_id, COALESCE(catalog_id, '00000000-0000-0000-0000-000000000000'::uuid), email)
           DO UPDATE SET
             total_orders = customers.total_orders + 1,
             total_spent = customers.total_spent + $4,
             last_order_at = NOW(),
             updated_at = NOW()
           RETURNING id`,
          [
            payload.organizationId,
            body.catalogId || null,
            customerEmail,
            totalAmount,
          ]
        );
        customerId = customerResult.rows[0].id;
      }

      // Create the order with catalog_id and customer_id as proper columns
      const orderResult = await client.query(
        `INSERT INTO orders (
          organization_id, user_id, catalog_id, customer_id, order_number, status, payment_method,
          subtotal, tax_amount, tip_amount, total_amount,
          stripe_payment_intent_id, customer_email, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *`,
        [
          payload.organizationId,
          payload.userId,
          body.catalogId || null,
          customerId,
          orderNumber,
          'pending',
          body.paymentMethod || 'tap_to_pay',
          subtotal,
          taxAmount,
          tipAmount,
          totalAmount,
          body.stripePaymentIntentId || null,
          customerEmail,
          JSON.stringify({
            isQuickCharge: body.isQuickCharge || false,
            description: body.description || null,
          }),
        ]
      );

      const order = orderResult.rows[0];

      // Create order items if provided (cart checkout)
      const orderItems: any[] = [];
      if (body.items && body.items.length > 0) {
        for (const item of body.items) {
          const itemResult = await client.query(
            `INSERT INTO order_items (order_id, product_id, category_id, name, quantity, unit_price)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
              order.id,
              item.productId,
              item.categoryId || null,
              item.name,
              item.quantity,
              item.unitPrice / 100, // Convert cents to dollars
            ]
          );
          orderItems.push({
            id: itemResult.rows[0].id,
            productId: item.productId,
            categoryId: itemResult.rows[0].category_id,
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          });
        }
      }

      return { order, orderItems, customerId };
    });

    logger.info('Order created', {
      orderId: result.order.id,
      orderNumber,
      organizationId: payload.organizationId,
      catalogId: body.catalogId || null,
      customerId: result.customerId,
      customerEmail,
      isQuickCharge: body.isQuickCharge,
      itemCount: body.items?.length || 0,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.ORDER_CREATED, {
      orderId: result.order.id,
      orderNumber,
      status: result.order.status,
      totalAmount: parseFloat(result.order.total_amount) * 100,
    });

    return c.json({
      id: result.order.id,
      orderNumber: result.order.order_number,
      status: result.order.status,
      paymentMethod: result.order.payment_method,
      subtotal: parseFloat(result.order.subtotal) * 100, // Return in cents
      taxAmount: parseFloat(result.order.tax_amount) * 100,
      tipAmount: parseFloat(result.order.tip_amount) * 100,
      totalAmount: parseFloat(result.order.total_amount) * 100,
      stripePaymentIntentId: result.order.stripe_payment_intent_id,
      customerEmail: result.order.customer_email,
      catalogId: result.order.catalog_id || null,
      customerId: result.customerId,
      items: result.orderItems,
      createdAt: result.order.created_at.toISOString(),
      updatedAt: result.order.updated_at.toISOString(),
    }, 201);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error creating order', { error });
    return c.json({ error: 'Failed to create order' }, 500);
  }
});

// Update order with PaymentIntent ID and optionally payment method
const updateOrderPaymentIntentRoute = createRoute({
  method: 'patch',
  path: '/orders/{id}/payment-intent',
  summary: 'Link a Stripe PaymentIntent to an order and optionally update payment method',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            stripePaymentIntentId: z.string(),
            paymentMethod: z.enum(['card', 'cash', 'tap_to_pay']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Order updated',
      content: {
        'application/json': {
          schema: orderSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Order not found' },
  },
});

app.openapi(updateOrderPaymentIntentRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    logger.info('[ORDER DEBUG] Updating order with payment intent', {
      orderId: id,
      stripePaymentIntentId: body.stripePaymentIntentId,
      paymentMethod: body.paymentMethod,
      organizationId: payload.organizationId,
    });

    // Build dynamic SET clause based on provided fields
    const setClauses = ['stripe_payment_intent_id = $1', 'status = \'processing\'', 'updated_at = NOW()'];
    const params: any[] = [body.stripePaymentIntentId];

    if (body.paymentMethod) {
      params.push(body.paymentMethod);
      setClauses.push(`payment_method = $${params.length}`);
    }

    params.push(id, payload.organizationId);

    const rows = await query(
      `UPDATE orders
       SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND organization_id = $${params.length}
       RETURNING *`,
      params
    );

    if (rows.length === 0) {
      logger.warn('[ORDER DEBUG] Order not found for update', {
        orderId: id,
        organizationId: payload.organizationId,
      });
      return c.json({ error: 'Order not found' }, 404);
    }

    const order = rows[0] as any;

    logger.info('[ORDER DEBUG] Order successfully linked to PaymentIntent', {
      orderId: id,
      paymentIntentId: body.stripePaymentIntentId,
      orderStatus: order.status,
      stripePaymentIntentIdInDB: order.stripe_payment_intent_id,
    });

    return c.json({
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      paymentMethod: order.payment_method,
      subtotal: parseFloat(order.subtotal) * 100,
      taxAmount: parseFloat(order.tax_amount) * 100,
      tipAmount: parseFloat(order.tip_amount) * 100,
      totalAmount: parseFloat(order.total_amount) * 100,
      stripePaymentIntentId: order.stripe_payment_intent_id,
      customerEmail: order.customer_email,
      customerId: order.customer_id || null,
      catalogId: order.catalog_id || null,
      createdAt: order.created_at.toISOString(),
      updatedAt: order.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating order', { error, orderId: id });
    return c.json({ error: 'Failed to update order' }, 500);
  }
});

// Get order by ID
const getOrderRoute = createRoute({
  method: 'get',
  path: '/orders/{id}',
  summary: 'Get order by ID',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Order details',
      content: {
        'application/json': {
          schema: orderSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Order not found' },
  },
});

app.openapi(getOrderRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const orderRows = await query(
      `SELECT * FROM orders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (orderRows.length === 0) {
      return c.json({ error: 'Order not found' }, 404);
    }

    const order = orderRows[0] as any;

    // Get order items
    const itemRows = await query(
      `SELECT * FROM order_items WHERE order_id = $1`,
      [id]
    );

    const items = itemRows.map((item: any) => ({
      id: item.id,
      productId: item.product_id,
      categoryId: item.category_id || null,
      name: item.name,
      quantity: item.quantity,
      unitPrice: parseFloat(item.unit_price) * 100,
    }));

    return c.json({
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      paymentMethod: order.payment_method,
      subtotal: parseFloat(order.subtotal) * 100,
      taxAmount: parseFloat(order.tax_amount) * 100,
      tipAmount: parseFloat(order.tip_amount) * 100,
      totalAmount: parseFloat(order.total_amount) * 100,
      stripePaymentIntentId: order.stripe_payment_intent_id,
      customerEmail: order.customer_email,
      customerId: order.customer_id || null,
      catalogId: order.catalog_id || null,
      items,
      createdAt: order.created_at.toISOString(),
      updatedAt: order.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error fetching order', { error, orderId: id });
    return c.json({ error: 'Failed to fetch order' }, 500);
  }
});

// List orders
const listOrdersRoute = createRoute({
  method: 'get',
  path: '/orders',
  summary: 'List orders for the organization',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.string().optional().default('25'),
      offset: z.string().optional().default('0'),
      status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded']).optional(),
      catalogId: z.string().uuid().optional(),
      customerId: z.string().uuid().optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of orders',
      content: {
        'application/json': {
          schema: z.object({
            orders: z.array(orderSchema),
            total: z.number(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listOrdersRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { limit, offset, status, catalogId, customerId } = c.req.query();

    let whereClause = 'organization_id = $1';
    const params: any[] = [payload.organizationId];

    if (status) {
      params.push(status);
      whereClause += ` AND status = $${params.length}`;
    }

    if (catalogId) {
      params.push(catalogId);
      whereClause += ` AND catalog_id = $${params.length}`;
    }

    if (customerId) {
      params.push(customerId);
      whereClause += ` AND customer_id = $${params.length}`;
    }

    const countResult = await query(
      `SELECT COUNT(*) as total FROM orders WHERE ${whereClause}`,
      params
    );
    const total = parseInt((countResult[0] as any).total, 10);

    params.push(parseInt(limit, 10), parseInt(offset, 10));
    const rows = await query(
      `SELECT * FROM orders
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const orders = rows.map((order: any) => ({
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      paymentMethod: order.payment_method,
      subtotal: parseFloat(order.subtotal) * 100,
      taxAmount: parseFloat(order.tax_amount) * 100,
      tipAmount: parseFloat(order.tip_amount) * 100,
      totalAmount: parseFloat(order.total_amount) * 100,
      stripePaymentIntentId: order.stripe_payment_intent_id,
      customerEmail: order.customer_email,
      customerId: order.customer_id || null,
      catalogId: order.catalog_id || null,
      createdAt: order.created_at.toISOString(),
      updatedAt: order.updated_at.toISOString(),
    }));

    return c.json({ orders, total });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing orders', { error });
    return c.json({ error: 'Failed to list orders' }, 500);
  }
});

export default app;
