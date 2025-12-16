import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { Catalog } from '../db/models';
import { logger } from '../utils/logger';

const app = new OpenAPIHono();

// Schema definitions
const catalogSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  date: z.string().nullable(),
  isActive: z.boolean(),
  productCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createCatalogSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

const updateCatalogSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
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
        (SELECT COUNT(*) FROM products WHERE catalog_id = c.id)::int as product_count
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
        (SELECT COUNT(*) FROM products WHERE catalog_id = c.id)::int as product_count
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
      `INSERT INTO catalogs (organization_id, name, description, location, date, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        payload.organizationId,
        body.name,
        body.description || null,
        body.location || null,
        body.date || null,
        body.isActive ?? true,
      ]
    );

    const row = rows[0];
    logger.info('Catalog created', { catalogId: row.id, organizationId: payload.organizationId });

    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      location: row.location,
      date: row.date,
      isActive: row.is_active,
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

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    updates.push(`updated_at = NOW()`);
    values.push(id, payload.organizationId);

    const rows = await query<Catalog & { product_count: number }>(
      `UPDATE catalogs
       SET ${updates.join(', ')}
       WHERE id = $${paramCount} AND organization_id = $${paramCount + 1}
       RETURNING *, (SELECT COUNT(*) FROM products WHERE catalog_id = catalogs.id)::int as product_count`,
      values
    );

    if (!rows[0]) {
      return c.json({ error: 'Catalog not found' }, 404);
    }

    const row = rows[0];
    logger.info('Catalog updated', { catalogId: row.id });

    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      location: row.location,
      date: row.date,
      isActive: row.is_active,
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
