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
  notes: z.string().max(500).optional(), // per-item notes
});

const orderSchema = z.object({
  id: z.string().uuid(),
  orderNumber: z.string(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded', 'held']),
  paymentMethod: z.enum(['card', 'cash', 'tap_to_pay', 'split']).nullable(),
  subtotal: z.number(),
  taxAmount: z.number(),
  tipAmount: z.number(),
  totalAmount: z.number(),
  stripePaymentIntentId: z.string().nullable(),
  customerEmail: z.string().nullable(),
  customerId: z.string().uuid().nullable(),
  catalogId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  deviceId: z.string().nullable(),
  notes: z.string().nullable().optional(), // order-level notes
  holdName: z.string().nullable().optional(), // name for held orders
  heldAt: z.string().nullable().optional(), // when order was held
  heldBy: z.string().uuid().nullable().optional(), // who held it
  itemCount: z.number().optional(), // count of items in order
  items: z.array(z.object({
    id: z.string().uuid(),
    productId: z.string().uuid().nullable(),
    categoryId: z.string().uuid().nullable(),
    name: z.string(),
    quantity: z.number(),
    unitPrice: z.number(),
    notes: z.string().nullable().optional(), // per-item notes
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
  paymentMethod: z.enum(['card', 'cash', 'tap_to_pay', 'split']).optional().default('tap_to_pay'),
  customerEmail: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().email().optional()
  ),
  stripePaymentIntentId: z.string().optional(),
  isQuickCharge: z.boolean().optional().default(false),
  description: z.string().optional(),
  deviceId: z.string().optional(),
  notes: z.string().max(1000).optional(), // order-level notes
  holdName: z.string().max(100).optional(), // for creating held orders
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
          stripe_payment_intent_id, customer_email, device_id, notes, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
          body.deviceId || null,
          body.notes || null,
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
            `INSERT INTO order_items (order_id, product_id, category_id, name, quantity, unit_price, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              order.id,
              item.productId,
              item.categoryId || null,
              item.name,
              item.quantity,
              item.unitPrice / 100, // Convert cents to dollars
              item.notes || null,
            ]
          );
          orderItems.push({
            id: itemResult.rows[0].id,
            productId: item.productId,
            categoryId: itemResult.rows[0].category_id,
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            notes: itemResult.rows[0].notes || null,
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
    const orderEventData = {
      orderId: result.order.id,
      orderNumber,
      status: result.order.status,
      totalAmount: parseFloat(result.order.total_amount) * 100,
      deviceId: result.order.device_id,
    };
    socketService.emitToOrganization(payload.organizationId, SocketEvents.ORDER_CREATED, orderEventData);
    // Also emit to device if specified
    if (result.order.device_id) {
      socketService.emitToDevice(result.order.device_id, SocketEvents.ORDER_CREATED, orderEventData);
    }

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
      userId: result.order.user_id || null,
      deviceId: result.order.device_id || null,
      notes: result.order.notes || null,
      holdName: result.order.hold_name || null,
      heldAt: result.order.held_at?.toISOString() || null,
      heldBy: result.order.held_by || null,
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

// ============================================
// List Held Orders
// IMPORTANT: This route MUST be defined BEFORE /orders/{id} to avoid matching "held" as a UUID
// ============================================
const listHeldOrdersRoute = createRoute({
  method: 'get',
  path: '/orders/held',
  summary: 'List held orders for the organization',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      deviceId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of held orders',
      content: {
        'application/json': {
          schema: z.object({
            orders: z.array(orderSchema),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listHeldOrdersRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { deviceId } = c.req.query();

    logger.info('Listing held orders', {
      organizationId: payload.organizationId,
      deviceId: deviceId || 'all',
    });

    let whereClause = 'organization_id = $1 AND status = \'held\'';
    const params: any[] = [payload.organizationId];

    if (deviceId) {
      params.push(deviceId);
      whereClause += ` AND device_id = $${params.length}`;
    }

    const rows = await query(
      `SELECT o.*,
              (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
       FROM orders o
       WHERE ${whereClause}
       ORDER BY held_at DESC`,
      params
    );

    logger.info('Held orders query result', {
      organizationId: payload.organizationId,
      count: rows.length,
      orderIds: rows.map((r: any) => r.id),
      statuses: rows.map((r: any) => r.status),
    });

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
      userId: order.user_id || null,
      deviceId: order.device_id || null,
      notes: order.notes || null,
      holdName: order.hold_name || null,
      heldAt: order.held_at?.toISOString() || null,
      heldBy: order.held_by || null,
      itemCount: parseInt(order.item_count, 10),
      createdAt: order.created_at.toISOString(),
      updatedAt: order.updated_at.toISOString(),
    }));

    return c.json({ orders });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing held orders', {
      errorMessage: error.message,
      errorCode: error.code,
      errorDetail: error.detail,
    });
    return c.json({ error: 'Failed to list held orders' }, 500);
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

    // Get order items with product images
    const itemRows = await query(
      `SELECT oi.*, p.image_url
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1`,
      [id]
    );

    const items = itemRows.map((item: any) => ({
      id: item.id,
      productId: item.product_id,
      categoryId: item.category_id || null,
      name: item.name,
      quantity: item.quantity,
      unitPrice: parseFloat(item.unit_price) * 100,
      notes: item.notes || null,
      imageUrl: item.image_url || null,
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
      userId: order.user_id || null,
      deviceId: order.device_id || null,
      notes: order.notes || null,
      holdName: order.hold_name || null,
      heldAt: order.held_at?.toISOString() || null,
      heldBy: order.held_by || null,
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
      status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded', 'held']).optional(),
      catalogId: z.string().uuid().optional(),
      customerId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
      deviceId: z.string().optional(),
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
    const { limit, offset, status, catalogId, customerId, userId, deviceId } = c.req.query();

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

    if (userId) {
      params.push(userId);
      whereClause += ` AND user_id = $${params.length}`;
    }

    if (deviceId) {
      params.push(deviceId);
      whereClause += ` AND device_id = $${params.length}`;
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
      userId: order.user_id || null,
      deviceId: order.device_id || null,
      notes: order.notes || null,
      holdName: order.hold_name || null,
      heldAt: order.held_at?.toISOString() || null,
      heldBy: order.held_by || null,
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

// ============================================
// Hold Order - Put order on hold (open tab)
// ============================================
const holdOrderRoute = createRoute({
  method: 'post',
  path: '/orders/{id}/hold',
  summary: 'Put an order on hold (open tab)',
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
            holdName: z.string().max(100).optional(),
            // Optional fields to update when re-holding a resumed order
            tipAmount: z.number().int().optional(),
            taxAmount: z.number().int().optional(),
            subtotal: z.number().int().optional(),
            totalAmount: z.number().int().optional(),
            paymentMethod: z.enum(['card', 'cash', 'tap_to_pay', 'split']).optional(),
            customerEmail: z.preprocess(
              (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
              z.string().email().optional()
            ),
            notes: z.string().max(1000).optional().nullable(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Order held',
      content: {
        'application/json': {
          schema: orderSchema,
        },
      },
    },
    400: { description: 'Order cannot be held' },
    401: { description: 'Unauthorized' },
    404: { description: 'Order not found' },
  },
});

app.openapi(holdOrderRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json() as any;

    // Only pending orders can be held
    const existingOrder = await query(
      `SELECT status FROM orders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (existingOrder.length === 0) {
      return c.json({ error: 'Order not found' }, 404);
    }

    const currentStatus = (existingOrder[0] as any).status;
    if (currentStatus !== 'pending') {
      return c.json({ error: `Cannot hold order with status: ${currentStatus}` }, 400);
    }

    logger.info('[HOLD DEBUG] Hold order request body', {
      orderId: id,
      currentStatus,
      bodyKeys: Object.keys(body),
      paymentMethod: body.paymentMethod,
      body: JSON.stringify(body),
    });

    // Build dynamic SET clause for optional field updates
    const setClauses = [
      'status = \'held\'',
      'held_at = NOW()',
      'held_by = $1',
      'hold_name = $2',
      'updated_at = NOW()',
    ];
    const params: any[] = [payload.userId, body.holdName || null];

    if (body.tipAmount !== undefined) {
      params.push(body.tipAmount / 100);
      setClauses.push(`tip_amount = $${params.length}`);
    }
    if (body.taxAmount !== undefined) {
      params.push(body.taxAmount / 100);
      setClauses.push(`tax_amount = $${params.length}`);
    }
    if (body.subtotal !== undefined) {
      params.push(body.subtotal / 100);
      setClauses.push(`subtotal = $${params.length}`);
    }
    if (body.totalAmount !== undefined) {
      params.push(body.totalAmount / 100);
      setClauses.push(`total_amount = $${params.length}`);
    }
    if (body.paymentMethod) {
      params.push(body.paymentMethod);
      setClauses.push(`payment_method = $${params.length}`);
    }
    if (body.customerEmail !== undefined) {
      params.push(body.customerEmail?.toLowerCase().trim() || null);
      setClauses.push(`customer_email = $${params.length}`);
    }
    if (body.notes !== undefined) {
      params.push(body.notes || null);
      setClauses.push(`notes = $${params.length}`);
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
      logger.error('Hold order update returned no rows', { orderId: id });
      return c.json({ error: 'Failed to update order - no rows returned' }, 500);
    }

    const order = rows[0] as any;

    // Verify the status was actually updated
    if (order.status !== 'held') {
      logger.error('Hold order status mismatch', {
        orderId: id,
        expectedStatus: 'held',
        actualStatus: order.status,
      });
      return c.json({ error: `Order hold failed - status is ${order.status}` }, 500);
    }

    logger.info('Order held successfully', {
      orderId: id,
      holdName: body.holdName,
      userId: payload.userId,
      status: order.status,
    });

    // Emit socket event to organization and device
    const holdEventData = {
      orderId: order.id,
      orderNumber: order.order_number,
      status: 'held',
      holdName: order.hold_name,
      deviceId: order.device_id,
    };
    logger.info('[SOCKET DEBUG] Emitting ORDER_UPDATED for held order', {
      event: SocketEvents.ORDER_UPDATED,
      organizationId: payload.organizationId,
      deviceId: order.device_id,
      data: holdEventData,
    });
    socketService.emitToOrganization(payload.organizationId, SocketEvents.ORDER_UPDATED, holdEventData);
    if (order.device_id) {
      socketService.emitToDevice(order.device_id, SocketEvents.ORDER_UPDATED, holdEventData);
    }

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
      userId: order.user_id || null,
      deviceId: order.device_id || null,
      notes: order.notes || null,
      holdName: order.hold_name || null,
      heldAt: order.held_at?.toISOString() || null,
      heldBy: order.held_by || null,
      createdAt: order.created_at.toISOString(),
      updatedAt: order.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error holding order', {
      orderId: id,
      errorMessage: error.message,
      errorCode: error.code,
      errorDetail: error.detail,
      errorStack: error.stack,
    });
    return c.json({ error: `Failed to hold order: ${error.message}` }, 500);
  }
});

// ============================================
// Resume Order - Resume a held order
// ============================================
const resumeOrderRoute = createRoute({
  method: 'post',
  path: '/orders/{id}/resume',
  summary: 'Resume a held order',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Order resumed',
      content: {
        'application/json': {
          schema: orderSchema,
        },
      },
    },
    400: { description: 'Order cannot be resumed' },
    401: { description: 'Unauthorized' },
    404: { description: 'Order not found' },
  },
});

app.openapi(resumeOrderRoute, async (c) => {
  const { id } = c.req.param();

  logger.info('Resume order request received', { orderId: id });

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    logger.info('Resume order - checking order status', {
      orderId: id,
      organizationId: payload.organizationId,
      userId: payload.userId,
    });

    // Only held orders can be resumed
    const existingOrder = await query(
      `SELECT status, hold_name, held_at FROM orders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (existingOrder.length === 0) {
      logger.warn('Resume order - order not found', { orderId: id });
      return c.json({ error: 'Order not found' }, 404);
    }

    const orderData = existingOrder[0] as any;
    const currentStatus = orderData.status;

    logger.info('Resume order - current order state', {
      orderId: id,
      currentStatus,
      holdName: orderData.hold_name,
      heldAt: orderData.held_at,
    });

    if (currentStatus !== 'held') {
      logger.warn('Resume order - cannot resume, wrong status', {
        orderId: id,
        currentStatus,
        expectedStatus: 'held',
      });
      return c.json({ error: `Cannot resume order with status: ${currentStatus}` }, 400);
    }

    logger.info('Resume order - updating order to pending', { orderId: id });

    const rows = await query(
      `UPDATE orders
       SET status = 'pending',
           held_at = NULL,
           held_by = NULL,
           updated_at = NOW()
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [id, payload.organizationId]
    );

    const order = rows[0] as any;

    logger.info('Resume order - order updated', {
      orderId: id,
      newStatus: order.status,
    });

    // Get order items with product images
    const itemRows = await query(
      `SELECT oi.*, p.image_url
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1`,
      [id]
    );

    const items = itemRows.map((item: any) => ({
      id: item.id,
      productId: item.product_id,
      categoryId: item.category_id || null,
      name: item.name,
      quantity: item.quantity,
      unitPrice: parseFloat(item.unit_price) * 100,
      notes: item.notes || null,
      imageUrl: item.image_url || null,
    }));

    logger.info('Order resumed successfully', {
      orderId: id,
      userId: payload.userId,
      itemCount: items.length,
    });

    // Emit socket event to organization and device
    const resumeEventData = {
      orderId: order.id,
      orderNumber: order.order_number,
      status: 'pending',
      deviceId: order.device_id,
    };
    logger.info('[SOCKET DEBUG] Emitting ORDER_UPDATED for resumed order', {
      event: SocketEvents.ORDER_UPDATED,
      organizationId: payload.organizationId,
      deviceId: order.device_id,
      data: resumeEventData,
    });
    socketService.emitToOrganization(payload.organizationId, SocketEvents.ORDER_UPDATED, resumeEventData);
    if (order.device_id) {
      socketService.emitToDevice(order.device_id, SocketEvents.ORDER_UPDATED, resumeEventData);
    }

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
      userId: order.user_id || null,
      deviceId: order.device_id || null,
      notes: order.notes || null,
      holdName: order.hold_name || null,
      heldAt: null,
      heldBy: null,
      items,
      createdAt: order.created_at.toISOString(),
      updatedAt: order.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error resuming order', {
      orderId: id,
      errorMessage: error.message,
      errorCode: error.code,
      errorDetail: error.detail,
      errorStack: error.stack,
    });
    return c.json({ error: `Failed to resume order: ${error.message}` }, 500);
  }
});

// ============================================
// Complete Cash Payment
// ============================================
const completeCashPaymentRoute = createRoute({
  method: 'post',
  path: '/orders/{id}/complete-cash',
  summary: 'Complete an order with cash payment',
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
            cashTendered: z.number().int().positive(), // in cents
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Order completed with cash',
      content: {
        'application/json': {
          schema: z.object({
            order: orderSchema,
            changeAmount: z.number(),
          }),
        },
      },
    },
    400: { description: 'Invalid request or insufficient cash' },
    401: { description: 'Unauthorized' },
    404: { description: 'Order not found' },
  },
});

app.openapi(completeCashPaymentRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    // Get the order
    const existingOrder = await query(
      `SELECT * FROM orders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (existingOrder.length === 0) {
      return c.json({ error: 'Order not found' }, 404);
    }

    const order = existingOrder[0] as any;
    const totalAmountCents = Math.round(parseFloat(order.total_amount) * 100);

    // Check that cash is sufficient
    if (body.cashTendered < totalAmountCents) {
      return c.json({
        error: 'Insufficient cash tendered',
        required: totalAmountCents,
        tendered: body.cashTendered,
      }, 400);
    }

    // Only pending or held orders can be completed
    if (!['pending', 'held'].includes(order.status)) {
      return c.json({ error: `Cannot complete order with status: ${order.status}` }, 400);
    }

    const changeAmount = body.cashTendered - totalAmountCents;

    // Update order to completed with cash payment
    const rows = await query(
      `UPDATE orders
       SET status = 'completed',
           payment_method = 'cash',
           held_at = NULL,
           held_by = NULL,
           updated_at = NOW()
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [id, payload.organizationId]
    );

    const updatedOrder = rows[0] as any;

    // Insert payment record for tracking
    await query(
      `INSERT INTO order_payments (order_id, payment_method, amount, tip_amount, status, cash_tendered, cash_change, processed_by, device_id)
       VALUES ($1, 'cash', $2, $3, 'completed', $4, $5, $6, $7)`,
      [
        id,
        totalAmountCents,
        Math.round(parseFloat(order.tip_amount) * 100),
        body.cashTendered,
        changeAmount,
        payload.userId,
        order.device_id,
      ]
    );

    logger.info('Order completed with cash', {
      orderId: id,
      totalAmount: totalAmountCents,
      cashTendered: body.cashTendered,
      changeAmount,
    });

    // Emit socket event to organization and device
    const cashCompleteEventData = {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.order_number,
      status: 'completed',
      paymentMethod: 'cash',
      totalAmount: totalAmountCents,
      deviceId: updatedOrder.device_id,
    };
    socketService.emitToOrganization(payload.organizationId, SocketEvents.ORDER_COMPLETED, cashCompleteEventData);
    if (updatedOrder.device_id) {
      socketService.emitToDevice(updatedOrder.device_id, SocketEvents.ORDER_COMPLETED, cashCompleteEventData);
    }

    return c.json({
      order: {
        id: updatedOrder.id,
        orderNumber: updatedOrder.order_number,
        status: updatedOrder.status,
        paymentMethod: updatedOrder.payment_method,
        subtotal: parseFloat(updatedOrder.subtotal) * 100,
        taxAmount: parseFloat(updatedOrder.tax_amount) * 100,
        tipAmount: parseFloat(updatedOrder.tip_amount) * 100,
        totalAmount: parseFloat(updatedOrder.total_amount) * 100,
        stripePaymentIntentId: updatedOrder.stripe_payment_intent_id,
        customerEmail: updatedOrder.customer_email,
        customerId: updatedOrder.customer_id || null,
        catalogId: updatedOrder.catalog_id || null,
        userId: updatedOrder.user_id || null,
        deviceId: updatedOrder.device_id || null,
        notes: updatedOrder.notes || null,
        holdName: updatedOrder.hold_name || null,
        heldAt: null,
        heldBy: null,
        createdAt: updatedOrder.created_at.toISOString(),
        updatedAt: updatedOrder.updated_at.toISOString(),
      },
      changeAmount,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error completing cash payment', { error, orderId: id });
    return c.json({ error: 'Failed to complete cash payment' }, 500);
  }
});

// ============================================
// Add Split Payment
// ============================================
const addPaymentRoute = createRoute({
  method: 'post',
  path: '/orders/{id}/payments',
  summary: 'Add a payment to an order (for split payments)',
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
            paymentMethod: z.enum(['card', 'cash', 'tap_to_pay']),
            amount: z.number().int().positive(), // in cents
            tipAmount: z.number().int().optional().default(0),
            stripePaymentIntentId: z.string().optional(),
            cashTendered: z.number().int().optional(), // for cash payments
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Payment added',
      content: {
        'application/json': {
          schema: z.object({
            payment: z.object({
              id: z.string().uuid(),
              paymentMethod: z.string(),
              amount: z.number(),
              tipAmount: z.number(),
              status: z.string(),
              cashTendered: z.number().nullable(),
              cashChange: z.number().nullable(),
            }),
            orderStatus: z.string(),
            totalPaid: z.number(),
            remainingBalance: z.number(),
          }),
        },
      },
    },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthorized' },
    404: { description: 'Order not found' },
  },
});

app.openapi(addPaymentRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    // Get the order
    const existingOrder = await query(
      `SELECT * FROM orders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (existingOrder.length === 0) {
      return c.json({ error: 'Order not found' }, 404);
    }

    const order = existingOrder[0] as any;
    const totalAmountCents = Math.round(parseFloat(order.total_amount) * 100);

    // Only pending or held orders can receive payments
    if (!['pending', 'held', 'processing'].includes(order.status)) {
      return c.json({ error: `Cannot add payment to order with status: ${order.status}` }, 400);
    }

    // Get existing payments
    const existingPayments = await query(
      `SELECT SUM(amount) as total_paid FROM order_payments WHERE order_id = $1 AND status = 'completed'`,
      [id]
    );
    const totalPaidSoFar = parseInt((existingPayments[0] as any).total_paid || '0', 10);

    // Calculate change for cash payments
    let cashChange: number | null = null;
    if (body.paymentMethod === 'cash' && body.cashTendered) {
      cashChange = body.cashTendered - body.amount;
      if (cashChange < 0) {
        return c.json({ error: 'Cash tendered is less than payment amount' }, 400);
      }
    }

    // Insert payment record
    const paymentResult = await query(
      `INSERT INTO order_payments (
        order_id, payment_method, amount, tip_amount, status,
        stripe_payment_intent_id, cash_tendered, cash_change, processed_by, device_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        id,
        body.paymentMethod,
        body.amount,
        body.tipAmount || 0,
        'completed', // For now, assume payment is completed when added
        body.stripePaymentIntentId || null,
        body.cashTendered || null,
        cashChange,
        payload.userId,
        order.device_id,
      ]
    );

    const payment = paymentResult[0] as any;
    const newTotalPaid = totalPaidSoFar + body.amount;
    const remainingBalance = totalAmountCents - newTotalPaid;

    // If fully paid, complete the order
    let orderStatus = order.status;
    if (remainingBalance <= 0) {
      await query(
        `UPDATE orders SET status = 'completed', payment_method = 'card', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      orderStatus = 'completed';

      // Emit socket event to organization and device
      const splitCompleteEventData = {
        orderId: order.id,
        orderNumber: order.order_number,
        status: 'completed',
        totalAmount: totalAmountCents,
        deviceId: order.device_id,
      };
      socketService.emitToOrganization(payload.organizationId, SocketEvents.ORDER_COMPLETED, splitCompleteEventData);
      if (order.device_id) {
        socketService.emitToDevice(order.device_id, SocketEvents.ORDER_COMPLETED, splitCompleteEventData);
      }
    }

    logger.info('Payment added to order', {
      orderId: id,
      paymentMethod: body.paymentMethod,
      amount: body.amount,
      totalPaid: newTotalPaid,
      remainingBalance,
    });

    return c.json({
      payment: {
        id: payment.id,
        paymentMethod: payment.payment_method,
        amount: payment.amount,
        tipAmount: payment.tip_amount,
        status: payment.status,
        cashTendered: payment.cash_tendered,
        cashChange: payment.cash_change,
      },
      orderStatus,
      totalPaid: newTotalPaid,
      remainingBalance: Math.max(0, remainingBalance),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error adding payment', { error, orderId: id });
    return c.json({ error: 'Failed to add payment' }, 500);
  }
});

// ============================================
// Get Order Payments
// ============================================
const getOrderPaymentsRoute = createRoute({
  method: 'get',
  path: '/orders/{id}/payments',
  summary: 'Get payments for an order',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'List of payments',
      content: {
        'application/json': {
          schema: z.object({
            payments: z.array(z.object({
              id: z.string().uuid(),
              paymentMethod: z.string(),
              amount: z.number(),
              tipAmount: z.number(),
              status: z.string(),
              cashTendered: z.number().nullable(),
              cashChange: z.number().nullable(),
              stripePaymentIntentId: z.string().nullable(),
              createdAt: z.string(),
            })),
            totalPaid: z.number(),
            orderTotal: z.number(),
            remainingBalance: z.number(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Order not found' },
  },
});

app.openapi(getOrderPaymentsRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Get order
    const orderResult = await query(
      `SELECT total_amount FROM orders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (orderResult.length === 0) {
      return c.json({ error: 'Order not found' }, 404);
    }

    const orderTotal = Math.round(parseFloat((orderResult[0] as any).total_amount) * 100);

    // Get payments
    const paymentRows = await query(
      `SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at ASC`,
      [id]
    );

    const payments = paymentRows.map((p: any) => ({
      id: p.id,
      paymentMethod: p.payment_method,
      amount: p.amount,
      tipAmount: p.tip_amount,
      status: p.status,
      cashTendered: p.cash_tendered,
      cashChange: p.cash_change,
      stripePaymentIntentId: p.stripe_payment_intent_id,
      createdAt: p.created_at.toISOString(),
    }));

    const totalPaid = payments
      .filter((p: any) => p.status === 'completed')
      .reduce((sum: number, p: any) => sum + p.amount, 0);

    return c.json({
      payments,
      totalPaid,
      orderTotal,
      remainingBalance: Math.max(0, orderTotal - totalPaid),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error getting order payments', { error, orderId: id });
    return c.json({ error: 'Failed to get order payments' }, 500);
  }
});

// ============================================
// Cancel/Delete Order
// ============================================
const cancelOrderRoute = createRoute({
  method: 'delete',
  path: '/orders/{id}',
  summary: 'Cancel/delete a pending or held order',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: { description: 'Order cancelled' },
    400: { description: 'Order cannot be cancelled' },
    401: { description: 'Unauthorized' },
    404: { description: 'Order not found' },
  },
});

app.openapi(cancelOrderRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Only pending or held orders can be cancelled
    const existingOrder = await query(
      `SELECT status, device_id FROM orders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (existingOrder.length === 0) {
      return c.json({ error: 'Order not found' }, 404);
    }

    const order = existingOrder[0] as any;
    if (!['pending', 'held'].includes(order.status)) {
      return c.json({ error: `Cannot cancel order with status: ${order.status}` }, 400);
    }

    // Delete order items first, then order
    await query(`DELETE FROM order_items WHERE order_id = $1`, [id]);
    await query(`DELETE FROM order_payments WHERE order_id = $1`, [id]);
    await query(`DELETE FROM orders WHERE id = $1 AND organization_id = $2`, [id, payload.organizationId]);

    logger.info('Order cancelled', { orderId: id, userId: payload.userId });

    // Emit socket event for order deletion
    const deleteEventData = {
      orderId: id,
      organizationId: payload.organizationId,
      deviceId: order.device_id,
    };
    logger.info('[SOCKET DEBUG] Emitting ORDER_DELETED for cancelled order', {
      event: SocketEvents.ORDER_DELETED,
      organizationId: payload.organizationId,
      deviceId: order.device_id,
      data: deleteEventData,
    });
    socketService.emitToOrganization(payload.organizationId, SocketEvents.ORDER_DELETED, deleteEventData);
    if (order.device_id) {
      socketService.emitToDevice(order.device_id, SocketEvents.ORDER_DELETED, deleteEventData);
    }

    return c.json({ success: true, message: 'Order cancelled' });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error cancelling order', { error, orderId: id });
    return c.json({ error: 'Failed to cancel order' }, 500);
  }
});

// ============================================
// Debug: Check Database Status
// ============================================
const debugStatusRoute = createRoute({
  method: 'get',
  path: '/orders/debug/status',
  summary: 'Check database enum values and column status (debug endpoint)',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Debug status information',
      content: {
        'application/json': {
          schema: z.object({
            enumValues: z.array(z.string()),
            hasHeldValue: z.boolean(),
            ordersTableColumns: z.array(z.string()),
            hasHeldColumns: z.boolean(),
            pendingOrderCount: z.number(),
            heldOrderCount: z.number(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(debugStatusRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Check transaction_status enum values
    const enumResult = await query(
      `SELECT enumlabel FROM pg_enum
       WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_status')
       ORDER BY enumsortorder`
    );
    const enumValues = enumResult.map((r: any) => r.enumlabel);
    const hasHeldValue = enumValues.includes('held');

    // Check orders table columns
    const columnsResult = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'orders'
       ORDER BY ordinal_position`
    );
    const columns = columnsResult.map((r: any) => r.column_name);
    const hasHeldColumns = columns.includes('held_at') && columns.includes('held_by') && columns.includes('hold_name');

    // Count orders by status
    const pendingCount = await query(
      `SELECT COUNT(*) as count FROM orders WHERE organization_id = $1 AND status = 'pending'`,
      [payload.organizationId]
    );
    const heldCount = await query(
      `SELECT COUNT(*) as count FROM orders WHERE organization_id = $1 AND status = 'held'`,
      [payload.organizationId]
    );

    logger.info('Debug status check', {
      organizationId: payload.organizationId,
      enumValues,
      hasHeldValue,
      columns,
      hasHeldColumns,
    });

    return c.json({
      enumValues,
      hasHeldValue,
      ordersTableColumns: columns,
      hasHeldColumns,
      pendingOrderCount: parseInt((pendingCount[0] as any).count, 10),
      heldOrderCount: parseInt((heldCount[0] as any).count, 10),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error in debug status', { error });
    return c.json({ error: error.message }, 500);
  }
});

export default app;
