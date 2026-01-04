import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { Catalog } from '../db/models';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';

const app = new OpenAPIHono();

// Schema definitions
const layoutTypeSchema = z.enum(['grid', 'list', 'large-grid', 'compact']);

const catalogSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  date: z.string().nullable(),
  isActive: z.boolean(),
  showTipScreen: z.boolean(),
  promptForEmail: z.boolean(),
  tipPercentages: z.array(z.number()),
  allowCustomTip: z.boolean(),
  taxRate: z.number(),
  layoutType: layoutTypeSchema,
  productCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createCatalogSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  date: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
  showTipScreen: z.boolean().optional().default(true),
  promptForEmail: z.boolean().optional().default(true),
  tipPercentages: z.array(z.number()).optional().default([15, 18, 20, 25]),
  allowCustomTip: z.boolean().optional().default(true),
  taxRate: z.number().min(0).max(100).optional().default(0),
  layoutType: layoutTypeSchema.optional().default('grid'),
});

const updateCatalogSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  date: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  showTipScreen: z.boolean().optional(),
  promptForEmail: z.boolean().optional(),
  tipPercentages: z.array(z.number()).optional(),
  allowCustomTip: z.boolean().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  layoutType: layoutTypeSchema.optional(),
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

// List catalogs for organization
const listCatalogsRoute = createRoute({
  method: 'get',
  path: '/catalogs',
  summary: 'List all catalogs for the organization',
  tags: ['Catalogs'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'List of catalogs',
      content: {
        'application/json': {
          schema: z.array(catalogSchema),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listCatalogsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const rows = await query<Catalog & { product_count: number }>(
      `SELECT c.*,
        (SELECT COUNT(*) FROM catalog_products WHERE catalog_id = c.id)::int as product_count
       FROM catalogs c
       WHERE c.organization_id = $1
       ORDER BY c.created_at DESC`,
      [payload.organizationId]
    );

    return c.json(rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      location: row.location,
      date: row.date,
      isActive: row.is_active,
      showTipScreen: row.show_tip_screen,
      promptForEmail: (row as any).prompt_for_email ?? true,
      tipPercentages: (row as any).tip_percentages ?? [15, 18, 20, 25],
      allowCustomTip: (row as any).allow_custom_tip ?? true,
      taxRate: parseFloat((row as any).tax_rate) || 0,
      layoutType: (row as any).layout_type || 'grid',
      productCount: row.product_count || 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing catalogs', { error });
    return c.json({ error: 'Failed to list catalogs' }, 500);
  }
});

// Get single catalog
const getCatalogRoute = createRoute({
  method: 'get',
  path: '/catalogs/{id}',
  summary: 'Get a catalog by ID',
  tags: ['Catalogs'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Catalog details',
      content: {
        'application/json': {
          schema: catalogSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(getCatalogRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const rows = await query<Catalog & { product_count: number }>(
      `SELECT c.*,
        (SELECT COUNT(*) FROM catalog_products WHERE catalog_id = c.id)::int as product_count
       FROM catalogs c
       WHERE c.id = $1 AND c.organization_id = $2`,
      [id, payload.organizationId]
    );

    if (!rows[0]) {
      return c.json({ error: 'Catalog not found' }, 404);
    }

    const row = rows[0];
    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      location: row.location,
      date: row.date,
      isActive: row.is_active,
      showTipScreen: row.show_tip_screen,
      promptForEmail: (row as any).prompt_for_email ?? true,
      tipPercentages: (row as any).tip_percentages ?? [15, 18, 20, 25],
      allowCustomTip: (row as any).allow_custom_tip ?? true,
      taxRate: parseFloat((row as any).tax_rate) || 0,
      layoutType: (row as any).layout_type || 'grid',
      productCount: row.product_count || 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error fetching catalog', { error, catalogId: id });
    return c.json({ error: 'Failed to fetch catalog' }, 500);
  }
});

// Create catalog
const createCatalogRoute = createRoute({
  method: 'post',
  path: '/catalogs',
  summary: 'Create a new catalog',
  tags: ['Catalogs'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: createCatalogSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Catalog created',
      content: {
        'application/json': {
          schema: catalogSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(createCatalogRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    const rows = await query<Catalog>(
      `INSERT INTO catalogs (organization_id, name, description, location, date, is_active, show_tip_screen, prompt_for_email, tip_percentages, allow_custom_tip, tax_rate, layout_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        payload.organizationId,
        body.name,
        body.description || null,
        body.location || null,
        body.date || null,
        body.isActive ?? true,
        body.showTipScreen ?? true,
        body.promptForEmail ?? true,
        JSON.stringify(body.tipPercentages ?? [15, 18, 20, 25]),
        body.allowCustomTip ?? true,
        body.taxRate ?? 0,
        body.layoutType || 'grid',
      ]
    );

    const row = rows[0];
    logger.info('Catalog created', { catalogId: row.id, organizationId: payload.organizationId });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.CATALOG_CREATED, {
      catalogId: row.id,
      name: row.name,
    });

    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      location: row.location,
      date: row.date,
      isActive: row.is_active,
      showTipScreen: row.show_tip_screen,
      promptForEmail: (row as any).prompt_for_email ?? true,
      tipPercentages: (row as any).tip_percentages ?? [15, 18, 20, 25],
      allowCustomTip: (row as any).allow_custom_tip ?? true,
      taxRate: parseFloat((row as any).tax_rate) || 0,
      layoutType: (row as any).layout_type || 'grid',
      productCount: 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }, 201);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error creating catalog', { error });
    return c.json({ error: 'Failed to create catalog' }, 500);
  }
});

// Update catalog
const updateCatalogRoute = createRoute({
  method: 'put',
  path: '/catalogs/{id}',
  summary: 'Update a catalog',
  tags: ['Catalogs'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateCatalogSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Catalog updated',
      content: {
        'application/json': {
          schema: catalogSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(updateCatalogRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    // Build update query dynamically
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (body.name !== undefined) {
      updates.push(`name = $${paramCount}`);
      values.push(body.name);
      paramCount++;
    }
    if (body.description !== undefined) {
      updates.push(`description = $${paramCount}`);
      values.push(body.description);
      paramCount++;
    }
    if (body.location !== undefined) {
      updates.push(`location = $${paramCount}`);
      values.push(body.location);
      paramCount++;
    }
    if (body.date !== undefined) {
      updates.push(`date = $${paramCount}`);
      values.push(body.date);
      paramCount++;
    }
    if (body.isActive !== undefined) {
      updates.push(`is_active = $${paramCount}`);
      values.push(body.isActive);
      paramCount++;
    }
    if (body.showTipScreen !== undefined) {
      updates.push(`show_tip_screen = $${paramCount}`);
      values.push(body.showTipScreen);
      paramCount++;
    }
    if (body.promptForEmail !== undefined) {
      updates.push(`prompt_for_email = $${paramCount}`);
      values.push(body.promptForEmail);
      paramCount++;
    }
    if (body.tipPercentages !== undefined) {
      updates.push(`tip_percentages = $${paramCount}`);
      values.push(JSON.stringify(body.tipPercentages));
      paramCount++;
    }
    if (body.allowCustomTip !== undefined) {
      updates.push(`allow_custom_tip = $${paramCount}`);
      values.push(body.allowCustomTip);
      paramCount++;
    }
    if (body.taxRate !== undefined) {
      updates.push(`tax_rate = $${paramCount}`);
      values.push(body.taxRate);
      paramCount++;
    }
    if (body.layoutType !== undefined) {
      updates.push(`layout_type = $${paramCount}`);
      values.push(body.layoutType);
      paramCount++;
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    updates.push(`updated_at = NOW()`);
    values.push(id, payload.organizationId);

    const rows = await query<Catalog & { product_count: number }>(
      `UPDATE catalogs
       SET ${updates.join(', ')}
       WHERE id = $${paramCount} AND organization_id = $${paramCount + 1}
       RETURNING *, (SELECT COUNT(*) FROM catalog_products WHERE catalog_id = catalogs.id)::int as product_count`,
      values
    );

    if (!rows[0]) {
      return c.json({ error: 'Catalog not found' }, 404);
    }

    const row = rows[0];
    logger.info('Catalog updated', { catalogId: row.id });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.CATALOG_UPDATED, {
      catalogId: row.id,
      name: row.name,
    });

    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      location: row.location,
      date: row.date,
      isActive: row.is_active,
      showTipScreen: row.show_tip_screen,
      promptForEmail: (row as any).prompt_for_email ?? true,
      tipPercentages: (row as any).tip_percentages ?? [15, 18, 20, 25],
      allowCustomTip: (row as any).allow_custom_tip ?? true,
      taxRate: parseFloat((row as any).tax_rate) || 0,
      layoutType: (row as any).layout_type || 'grid',
      productCount: row.product_count || 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating catalog', { error, catalogId: id });
    return c.json({ error: 'Failed to update catalog' }, 500);
  }
});

// Delete catalog
const deleteCatalogRoute = createRoute({
  method: 'delete',
  path: '/catalogs/{id}',
  summary: 'Delete a catalog',
  tags: ['Catalogs'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: { description: 'Catalog deleted' },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(deleteCatalogRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const result = await query(
      `DELETE FROM catalogs WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [id, payload.organizationId]
    );

    if (result.length === 0) {
      return c.json({ error: 'Catalog not found' }, 404);
    }

    logger.info('Catalog deleted', { catalogId: id });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.CATALOG_DELETED, {
      catalogId: id,
    });

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error deleting catalog', { error, catalogId: id });
    return c.json({ error: 'Failed to delete catalog' }, 500);
  }
});

export default app;
