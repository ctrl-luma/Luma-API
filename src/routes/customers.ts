import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { Customer } from '../db/models';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../utils/logger';

const app = new OpenAPIHono();

// Apply auth middleware to all routes
app.use('*', authMiddleware);

// List customers for organization
const listCustomersRoute = createRoute({
  method: 'get',
  path: '/customers',
  summary: 'List customers for organization',
  tags: ['Customers'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      search: z.string().optional(),
      limit: z.string().optional().default('50'),
      offset: z.string().optional().default('0'),
    }),
  },
  responses: {
    200: {
      description: 'List of customers',
      content: {
        'application/json': {
          schema: z.object({
            customers: z.array(z.object({
              id: z.string(),
              email: z.string(),
              name: z.string().nullable(),
              phone: z.string().nullable(),
              totalOrders: z.number(),
              totalSpent: z.number(),
              lastOrderAt: z.string().nullable(),
              createdAt: z.string(),
            })),
            total: z.number(),
          }),
        },
      },
    },
  },
});

app.openapi(listCustomersRoute, async (c) => {
  const user = c.get('user' as never) as { organizationId: string };
  const { search, limit, offset } = c.req.query();

  try {
    let whereClause = 'WHERE organization_id = $1';
    const params: any[] = [user.organizationId];
    let paramCount = 2;

    if (search) {
      whereClause += ` AND (email ILIKE $${paramCount} OR name ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM customers ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0]?.count || '0', 10);

    // Get customers
    params.push(parseInt(limit, 10), parseInt(offset, 10));
    const customers = await query<Customer>(
      `SELECT * FROM customers ${whereClause}
       ORDER BY last_order_at DESC NULLS LAST, created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      params
    );

    return c.json({
      customers: customers.map(customer => ({
        id: customer.id,
        email: customer.email,
        name: customer.name,
        phone: customer.phone,
        totalOrders: customer.total_orders,
        totalSpent: Number(customer.total_spent),
        lastOrderAt: customer.last_order_at?.toISOString() || null,
        createdAt: customer.created_at.toISOString(),
      })),
      total,
    });
  } catch (error) {
    logger.error('Error listing customers', { error, organizationId: user.organizationId });
    return c.json({ error: 'Failed to list customers' }, 500);
  }
});

// Create or update customer (upsert)
const upsertCustomerRoute = createRoute({
  method: 'post',
  path: '/customers',
  summary: 'Create or update a customer',
  tags: ['Customers'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
            name: z.string().optional(),
            phone: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Customer created or updated',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            email: z.string(),
            name: z.string().nullable(),
            phone: z.string().nullable(),
            totalOrders: z.number(),
            totalSpent: z.number(),
            lastOrderAt: z.string().nullable(),
            createdAt: z.string(),
            isNew: z.boolean(),
          }),
        },
      },
    },
  },
});

app.openapi(upsertCustomerRoute, async (c) => {
  const user = c.get('user' as never) as { organizationId: string };
  const body = await c.req.json();

  try {
    // Check if customer exists
    const existing = await query<Customer>(
      'SELECT * FROM customers WHERE organization_id = $1 AND email = $2',
      [user.organizationId, body.email.toLowerCase()]
    );

    let customer: Customer;
    let isNew = false;

    if (existing[0]) {
      // Update existing customer
      const updates: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (body.name !== undefined) {
        updates.push(`name = $${paramCount}`);
        values.push(body.name);
        paramCount++;
      }

      if (body.phone !== undefined) {
        updates.push(`phone = $${paramCount}`);
        values.push(body.phone);
        paramCount++;
      }

      if (updates.length > 0) {
        values.push(existing[0].id);
        const result = await query<Customer>(
          `UPDATE customers SET ${updates.join(', ')}, updated_at = NOW()
           WHERE id = $${paramCount} RETURNING *`,
          values
        );
        customer = result[0];
      } else {
        customer = existing[0];
      }
    } else {
      // Create new customer
      const result = await query<Customer>(
        `INSERT INTO customers (organization_id, email, name, phone)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [user.organizationId, body.email.toLowerCase(), body.name || null, body.phone || null]
      );
      customer = result[0];
      isNew = true;
    }

    logger.info('Customer upserted', {
      customerId: customer.id,
      organizationId: user.organizationId,
      isNew,
    });

    return c.json({
      id: customer.id,
      email: customer.email,
      name: customer.name,
      phone: customer.phone,
      totalOrders: customer.total_orders,
      totalSpent: Number(customer.total_spent),
      lastOrderAt: customer.last_order_at?.toISOString() || null,
      createdAt: customer.created_at.toISOString(),
      isNew,
    });
  } catch (error) {
    logger.error('Error upserting customer', { error, organizationId: user.organizationId });
    return c.json({ error: 'Failed to save customer' }, 500);
  }
});

// Search customers by email (for autocomplete)
const searchCustomersRoute = createRoute({
  method: 'get',
  path: '/customers/search',
  summary: 'Search customers by email',
  tags: ['Customers'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z.string().min(1),
      limit: z.string().optional().default('10'),
    }),
  },
  responses: {
    200: {
      description: 'Matching customers',
      content: {
        'application/json': {
          schema: z.object({
            customers: z.array(z.object({
              id: z.string(),
              email: z.string(),
              name: z.string().nullable(),
            })),
          }),
        },
      },
    },
  },
});

app.openapi(searchCustomersRoute, async (c) => {
  const user = c.get('user' as never) as { organizationId: string };
  const { q, limit } = c.req.query();

  try {
    const customers = await query<Customer>(
      `SELECT id, email, name FROM customers
       WHERE organization_id = $1 AND email ILIKE $2
       ORDER BY last_order_at DESC NULLS LAST
       LIMIT $3`,
      [user.organizationId, `%${q}%`, parseInt(limit, 10)]
    );

    return c.json({
      customers: customers.map(c => ({
        id: c.id,
        email: c.email,
        name: c.name,
      })),
    });
  } catch (error) {
    logger.error('Error searching customers', { error, organizationId: user.organizationId });
    return c.json({ error: 'Failed to search customers' }, 500);
  }
});

// Update customer order stats (called after payment)
const updateCustomerStatsRoute = createRoute({
  method: 'post',
  path: '/customers/{id}/record-order',
  summary: 'Record an order for a customer',
  tags: ['Customers'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            orderTotal: z.number(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Customer stats updated',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
          }),
        },
      },
    },
  },
});

app.openapi(updateCustomerStatsRoute, async (c) => {
  const user = c.get('user' as never) as { organizationId: string };
  const { id } = c.req.param();
  const { orderTotal } = await c.req.json();

  try {
    await query(
      `UPDATE customers
       SET total_orders = total_orders + 1,
           total_spent = total_spent + $1,
           last_order_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND organization_id = $3`,
      [orderTotal, id, user.organizationId]
    );

    return c.json({ success: true });
  } catch (error) {
    logger.error('Error updating customer stats', { error, customerId: id });
    return c.json({ error: 'Failed to update customer stats' }, 500);
  }
});

export default app;
