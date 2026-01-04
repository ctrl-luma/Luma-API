import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { Category } from '../db/models';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';

const app = new OpenAPIHono();

// Schema definitions (updated for catalog-specific categories)
// Note: layoutType has been moved to catalogs table (migration 017)
const categorySchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  sortOrder: z.number(),
  isActive: z.boolean(),
  productCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  icon: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  icon: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  isActive: z.boolean().optional(),
});

const reorderCategoriesSchema = z.object({
  categoryIds: z.array(z.string().uuid()),
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

// List categories for a catalog
const listCategoriesRoute = createRoute({
  method: 'get',
  path: '/catalogs/{catalogId}/categories',
  summary: 'List all categories for a catalog',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'List of categories',
      content: {
        'application/json': {
          schema: z.array(categorySchema),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(listCategoriesRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { catalogId } = c.req.param();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const rows = await query<Category & { product_count: number }>(
      `SELECT c.*,
        (SELECT COUNT(*) FROM catalog_products WHERE category_id = c.id)::int as product_count
       FROM categories c
       WHERE c.catalog_id = $1
       ORDER BY c.sort_order ASC, c.created_at DESC`,
      [catalogId]
    );

    return c.json(rows.map(row => ({
      id: row.id,
      catalogId: row.catalog_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      productCount: row.product_count || 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error listing categories', { error });
    return c.json({ error: 'Failed to list categories' }, 500);
  }
});

// Get single category
const getCategoryRoute = createRoute({
  method: 'get',
  path: '/catalogs/{catalogId}/categories/{id}',
  summary: 'Get a category by ID',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Category details',
      content: {
        'application/json': {
          schema: categorySchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Category not found' },
  },
});

app.openapi(getCategoryRoute, async (c) => {
  const { catalogId, id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const rows = await query<Category & { product_count: number }>(
      `SELECT c.*,
        (SELECT COUNT(*) FROM catalog_products WHERE category_id = c.id)::int as product_count
       FROM categories c
       WHERE c.id = $1 AND c.catalog_id = $2`,
      [id, catalogId]
    );

    if (!rows[0]) {
      return c.json({ error: 'Category not found' }, 404);
    }

    const row = rows[0];
    return c.json({
      id: row.id,
      catalogId: row.catalog_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      productCount: row.product_count || 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error fetching category', { error, id });
    return c.json({ error: 'Failed to fetch category' }, 500);
  }
});

// Create category
const createCategoryRoute = createRoute({
  method: 'post',
  path: '/catalogs/{catalogId}/categories',
  summary: 'Create a new category',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: createCategorySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Category created',
      content: {
        'application/json': {
          schema: categorySchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(createCategoryRoute, async (c) => {
  const { catalogId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    // Get max sort order
    const maxOrderResult = await query<{ max: number }>(
      'SELECT COALESCE(MAX(sort_order), -1) as max FROM categories WHERE catalog_id = $1',
      [catalogId]
    );
    const sortOrder = (maxOrderResult[0]?.max ?? -1) + 1;

    const rows = await query<Category>(
      `INSERT INTO categories (catalog_id, organization_id, name, description, icon, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        catalogId,
        payload.organizationId,
        body.name,
        body.description || null,
        body.icon || null,
        sortOrder,
        body.isActive ?? true,
      ]
    );

    const row = rows[0];
    logger.info('Category created', { categoryId: row.id, catalogId });

    // Emit socket event
    socketService.emitToOrganization(payload.organizationId, SocketEvents.CATEGORY_CREATED, {
      categoryId: row.id,
      catalogId,
      name: row.name,
    });

    return c.json({
      id: row.id,
      catalogId: row.catalog_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      productCount: 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }, 201);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error creating category', { error, catalogId });
    return c.json({ error: 'Failed to create category' }, 500);
  }
});

// Update category
const updateCategoryRoute = createRoute({
  method: 'patch',
  path: '/catalogs/{catalogId}/categories/{id}',
  summary: 'Update a category',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateCategorySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Category updated',
      content: {
        'application/json': {
          schema: categorySchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Category not found' },
  },
});

app.openapi(updateCategoryRoute, async (c) => {
  const { catalogId, id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

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
    if (body.icon !== undefined) {
      updates.push(`icon = $${paramCount}`);
      values.push(body.icon);
      paramCount++;
    }
    if (body.sortOrder !== undefined) {
      updates.push(`sort_order = $${paramCount}`);
      values.push(body.sortOrder);
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
    values.push(id, catalogId);

    const rows = await query<Category & { product_count: number }>(
      `UPDATE categories
       SET ${updates.join(', ')}
       WHERE id = $${paramCount} AND catalog_id = $${paramCount + 1}
       RETURNING *,
         (SELECT COUNT(*) FROM catalog_products WHERE category_id = categories.id)::int as product_count`,
      values
    );

    if (!rows[0]) {
      return c.json({ error: 'Category not found' }, 404);
    }

    const row = rows[0];
    logger.info('Category updated', { categoryId: row.id });

    // Emit socket event
    socketService.emitToOrganization(payload.organizationId, SocketEvents.CATEGORY_UPDATED, {
      categoryId: row.id,
      catalogId,
      name: row.name,
    });

    return c.json({
      id: row.id,
      catalogId: row.catalog_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      productCount: row.product_count || 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error updating category', { error, id });
    return c.json({ error: 'Failed to update category' }, 500);
  }
});

// Delete category
const deleteCategoryRoute = createRoute({
  method: 'delete',
  path: '/catalogs/{catalogId}/categories/{id}',
  summary: 'Delete a category',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      id: z.string().uuid(),
    }),
  },
  responses: {
    204: { description: 'Category deleted' },
    401: { description: 'Unauthorized' },
    404: { description: 'Category not found' },
  },
});

app.openapi(deleteCategoryRoute, async (c) => {
  const { catalogId, id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const result = await query(
      'DELETE FROM categories WHERE id = $1 AND catalog_id = $2 RETURNING id',
      [id, catalogId]
    );

    if (result.length === 0) {
      return c.json({ error: 'Category not found' }, 404);
    }

    logger.info('Category deleted', { categoryId: id, catalogId });

    // Emit socket event
    socketService.emitToOrganization(payload.organizationId, SocketEvents.CATEGORY_DELETED, {
      categoryId: id,
      catalogId,
    });

    return c.body(null, 204);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error deleting category', { error, id });
    return c.json({ error: 'Failed to delete category' }, 500);
  }
});

// Reorder categories
const reorderCategoriesRoute = createRoute({
  method: 'post',
  path: '/catalogs/{catalogId}/categories/reorder',
  summary: 'Reorder categories',
  tags: ['Categories'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: reorderCategoriesSchema,
        },
      },
    },
  },
  responses: {
    200: { description: 'Categories reordered' },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(reorderCategoriesRoute, async (c) => {
  const { catalogId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    // Update sort order for each category
    for (let i = 0; i < body.categoryIds.length; i++) {
      await query(
        'UPDATE categories SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND catalog_id = $3',
        [i, body.categoryIds[i], catalogId]
      );
    }

    logger.info('Categories reordered', { catalogId, count: body.categoryIds.length });

    // Emit socket event
    socketService.emitToOrganization(payload.organizationId, SocketEvents.CATEGORIES_REORDERED, {
      catalogId,
    });

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error reordering categories', { error, catalogId });
    return c.json({ error: 'Failed to reorder categories' }, 500);
  }
});

export default app;
