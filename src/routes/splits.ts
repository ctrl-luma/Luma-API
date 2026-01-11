import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { splitsService } from '../services/splits';
import { logger } from '../utils/logger';

const app = new OpenAPIHono();

// Schema definitions
const recipientTypeSchema = z.enum(['venue', 'promoter', 'partner', 'other']);

const splitSchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  recipientName: z.string(),
  recipientType: recipientTypeSchema,
  percentage: z.number(),
  notes: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createSplitSchema = z.object({
  recipientName: z.string().min(1).max(255),
  recipientType: recipientTypeSchema,
  percentage: z.number().min(0).max(100),
  notes: z.string().max(1000).nullable().optional(),
});

const updateSplitSchema = z.object({
  recipientName: z.string().min(1).max(255).optional(),
  recipientType: recipientTypeSchema.optional(),
  percentage: z.number().min(0).max(100).optional(),
  notes: z.string().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
});

const splitReportSchema = z.object({
  catalogId: z.string(),
  catalogName: z.string(),
  period: z.object({
    startDate: z.string(),
    endDate: z.string(),
  }),
  summary: z.object({
    grossSales: z.number(),
    totalSplitAmount: z.number(),
    yourShare: z.number(),
    orderCount: z.number(),
  }),
  splits: z.array(z.object({
    id: z.string(),
    recipientName: z.string(),
    recipientType: recipientTypeSchema,
    percentage: z.number(),
    amount: z.number(),
  })),
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

// Helper to verify catalog ownership
async function verifyCatalogOwnership(catalogId: string, organizationId: string) {
  const rows = await query(
    'SELECT id FROM catalogs WHERE id = $1 AND organization_id = $2',
    [catalogId, organizationId]
  );
  if (rows.length === 0) {
    throw new Error('Catalog not found');
  }
}

// Helper to check Pro subscription
async function verifyProSubscription(organizationId: string) {
  const result = await query<{ tier: string }>(
    `SELECT tier FROM subscriptions WHERE organization_id = $1 AND status IN ('active', 'trialing')`,
    [organizationId]
  );
  const subscription = result[0];
  if (!subscription || subscription.tier === 'starter') {
    throw new Error('Pro subscription required');
  }
}

// List splits for a catalog
const listSplitsRoute = createRoute({
  method: 'get',
  path: '/catalogs/{catalogId}/splits',
  summary: 'List all revenue splits for a catalog',
  tags: ['Revenue Splits'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'List of revenue splits',
      content: {
        'application/json': {
          schema: z.object({
            splits: z.array(splitSchema),
            totalPercentage: z.number(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(listSplitsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { catalogId } = c.req.param();

    await verifyProSubscription(payload.organizationId);
    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const splits = await splitsService.listByCatalog(catalogId, payload.organizationId);
    const totalPercentage = await splitsService.getTotalSplitPercentage(catalogId, payload.organizationId);

    return c.json({
      splits: splits.map(split => ({
        id: split.id,
        catalogId: split.catalog_id,
        recipientName: split.recipient_name,
        recipientType: split.recipient_type,
        percentage: Number(split.percentage),
        notes: split.notes,
        isActive: split.is_active,
        createdAt: split.created_at.toISOString(),
        updatedAt: split.updated_at.toISOString(),
      })),
      totalPercentage,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Pro subscription required') {
      return c.json({ error: 'Pro subscription required' }, 403);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error listing splits', { error });
    return c.json({ error: 'Failed to list splits' }, 500);
  }
});

// Create split
const createSplitRoute = createRoute({
  method: 'post',
  path: '/catalogs/{catalogId}/splits',
  summary: 'Create a new revenue split',
  tags: ['Revenue Splits'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: createSplitSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Revenue split created',
      content: {
        'application/json': {
          schema: splitSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(createSplitRoute, async (c) => {
  const { catalogId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    await verifyProSubscription(payload.organizationId);
    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const split = await splitsService.create({
      catalogId,
      organizationId: payload.organizationId,
      recipientName: body.recipientName,
      recipientType: body.recipientType,
      percentage: body.percentage,
      notes: body.notes,
    });

    return c.json({
      id: split.id,
      catalogId: split.catalog_id,
      recipientName: split.recipient_name,
      recipientType: split.recipient_type,
      percentage: Number(split.percentage),
      notes: split.notes,
      isActive: split.is_active,
      createdAt: split.created_at.toISOString(),
      updatedAt: split.updated_at.toISOString(),
    }, 201);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Pro subscription required') {
      return c.json({ error: 'Pro subscription required' }, 403);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    if (error.message === 'Percentage must be between 0 and 100') {
      return c.json({ error: error.message }, 400);
    }
    logger.error('Error creating split', { error, catalogId });
    return c.json({ error: 'Failed to create split' }, 500);
  }
});

// Update split
const updateSplitRoute = createRoute({
  method: 'patch',
  path: '/catalogs/{catalogId}/splits/{splitId}',
  summary: 'Update a revenue split',
  tags: ['Revenue Splits'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      splitId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateSplitSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Revenue split updated',
      content: {
        'application/json': {
          schema: splitSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Split not found' },
  },
});

app.openapi(updateSplitRoute, async (c) => {
  const { catalogId, splitId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    await verifyProSubscription(payload.organizationId);
    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const split = await splitsService.update(splitId, payload.organizationId, {
      recipientName: body.recipientName,
      recipientType: body.recipientType,
      percentage: body.percentage,
      notes: body.notes,
      isActive: body.isActive,
    });

    if (!split) {
      return c.json({ error: 'Split not found' }, 404);
    }

    return c.json({
      id: split.id,
      catalogId: split.catalog_id,
      recipientName: split.recipient_name,
      recipientType: split.recipient_type,
      percentage: Number(split.percentage),
      notes: split.notes,
      isActive: split.is_active,
      createdAt: split.created_at.toISOString(),
      updatedAt: split.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Pro subscription required') {
      return c.json({ error: 'Pro subscription required' }, 403);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    if (error.message === 'Percentage must be between 0 and 100') {
      return c.json({ error: error.message }, 400);
    }
    logger.error('Error updating split', { error, splitId });
    return c.json({ error: 'Failed to update split' }, 500);
  }
});

// Delete split
const deleteSplitRoute = createRoute({
  method: 'delete',
  path: '/catalogs/{catalogId}/splits/{splitId}',
  summary: 'Delete a revenue split',
  tags: ['Revenue Splits'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      splitId: z.string().uuid(),
    }),
  },
  responses: {
    204: { description: 'Split deleted' },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Split not found' },
  },
});

app.openapi(deleteSplitRoute, async (c) => {
  const { catalogId, splitId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    await verifyProSubscription(payload.organizationId);
    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const deleted = await splitsService.delete(splitId, payload.organizationId);

    if (!deleted) {
      return c.json({ error: 'Split not found' }, 404);
    }

    return c.body(null, 204);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Pro subscription required') {
      return c.json({ error: 'Pro subscription required' }, 403);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error deleting split', { error, splitId });
    return c.json({ error: 'Failed to delete split' }, 500);
  }
});

// Get split report
const getSplitReportRoute = createRoute({
  method: 'get',
  path: '/catalogs/{catalogId}/splits/report',
  summary: 'Get revenue split report for a catalog',
  tags: ['Revenue Splits'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
    query: z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  },
  responses: {
    200: {
      description: 'Revenue split report',
      content: {
        'application/json': {
          schema: splitReportSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Pro subscription required' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(getSplitReportRoute, async (c) => {
  const { catalogId } = c.req.param();
  const { startDate, endDate } = c.req.query();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    await verifyProSubscription(payload.organizationId);
    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const report = await splitsService.getReport(
      catalogId,
      payload.organizationId,
      startDate,
      endDate
    );

    return c.json(report);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Pro subscription required') {
      return c.json({ error: 'Pro subscription required' }, 403);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error getting split report', { error, catalogId });
    return c.json({ error: 'Failed to get split report' }, 500);
  }
});

export default app;
