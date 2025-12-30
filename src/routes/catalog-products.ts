import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { CatalogProduct } from '../db/models';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';

const app = new OpenAPIHono();

// Schema definitions
const catalogProductSchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  productId: z.string(),
  categoryId: z.string().nullable(),
  price: z.number(),
  sortOrder: z.number(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Include product details in response
  product: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    imageId: z.string().nullable(),
    imageUrl: z.string().nullable(),
  }),
  // Include category details if present
  category: z.object({
    id: z.string(),
    name: z.string(),
  }).nullable(),
});

const addProductToCatalogSchema = z.object({
  productId: z.string().uuid(),
  categoryId: z.string().uuid().nullable().optional(),
  price: z.number().int().min(0),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

const updateCatalogProductSchema = z.object({
  categoryId: z.string().uuid().nullable().optional(),
  price: z.number().int().min(0).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const bulkAddProductsSchema = z.object({
  products: z.array(z.object({
    productId: z.string().uuid(),
    categoryId: z.string().uuid().nullable().optional(),
    price: z.number().int().min(0),
    sortOrder: z.number().int().optional().default(0),
    isActive: z.boolean().optional().default(true),
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

// List all products in a catalog
const listCatalogProductsRoute = createRoute({
  method: 'get',
  path: '/catalogs/{catalogId}/products',
  summary: 'List all products in a catalog',
  tags: ['Catalog Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'List of products in catalog',
      content: {
        'application/json': {
          schema: z.array(catalogProductSchema),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(listCatalogProductsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { catalogId } = c.req.param();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const rows = await query(
      `SELECT
        cp.*,
        p.name as product_name,
        p.description as product_description,
        p.image_id as product_image_id,
        p.image_url as product_image_url,
        cat.name as category_name
       FROM catalog_products cp
       JOIN products p ON cp.product_id = p.id
       LEFT JOIN categories cat ON cp.category_id = cat.id
       WHERE cp.catalog_id = $1
       ORDER BY cp.sort_order ASC, cp.created_at DESC`,
      [catalogId]
    );

    return c.json(rows.map((row: any) => ({
      id: row.id,
      catalogId: row.catalog_id,
      productId: row.product_id,
      categoryId: row.category_id,
      price: row.price,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      product: {
        id: row.product_id,
        name: row.product_name,
        description: row.product_description,
        imageId: row.product_image_id,
        imageUrl: row.product_image_url,
      },
      category: row.category_id ? {
        id: row.category_id,
        name: row.category_name,
      } : null,
    })));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error listing catalog products', { error });
    return c.json({ error: 'Failed to list catalog products' }, 500);
  }
});

// Add product to catalog
const addProductToCatalogRoute = createRoute({
  method: 'post',
  path: '/catalogs/{catalogId}/products',
  summary: 'Add a product to a catalog',
  tags: ['Catalog Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: addProductToCatalogSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Product added to catalog',
      content: {
        'application/json': {
          schema: catalogProductSchema,
        },
      },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog or product not found' },
    409: { description: 'Product already in catalog' },
  },
});

app.openapi(addProductToCatalogRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { catalogId } = c.req.param();
    const body = await c.req.json();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    // Verify product exists and belongs to organization
    const productRows = await query(
      'SELECT id FROM products WHERE id = $1 AND organization_id = $2',
      [body.productId, payload.organizationId]
    );
    if (productRows.length === 0) {
      return c.json({ error: 'Product not found' }, 404);
    }

    // Verify category if provided
    if (body.categoryId) {
      const categoryRows = await query(
        'SELECT id FROM categories WHERE id = $1 AND catalog_id = $2',
        [body.categoryId, catalogId]
      );
      if (categoryRows.length === 0) {
        return c.json({ error: 'Category not found or does not belong to this catalog' }, 400);
      }
    }

    // Check if product already in catalog
    const existingRows = await query(
      'SELECT id FROM catalog_products WHERE catalog_id = $1 AND product_id = $2',
      [catalogId, body.productId]
    );
    if (existingRows.length > 0) {
      return c.json({ error: 'Product already in catalog' }, 409);
    }

    // Add product to catalog
    const rows = await query<CatalogProduct>(
      `INSERT INTO catalog_products (catalog_id, product_id, category_id, price, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        catalogId,
        body.productId,
        body.categoryId || null,
        body.price,
        body.sortOrder || 0,
        body.isActive !== undefined ? body.isActive : true,
      ]
    );

    const catalogProduct = rows[0];

    // Get product and category details for response
    const detailRows = await query(
      `SELECT
        cp.*,
        p.name as product_name,
        p.description as product_description,
        p.image_id as product_image_id,
        p.image_url as product_image_url,
        cat.name as category_name
       FROM catalog_products cp
       JOIN products p ON cp.product_id = p.id
       LEFT JOIN categories cat ON cp.category_id = cat.id
       WHERE cp.id = $1`,
      [catalogProduct.id]
    );

    const row = detailRows[0] as any;

    // Emit socket event
    socketService.emitToOrganization(
      payload.organizationId,
      SocketEvents.CATALOG_UPDATED,
      { catalogId, type: 'product_added' }
    );

    return c.json({
      id: row.id,
      catalogId: row.catalog_id,
      productId: row.product_id,
      categoryId: row.category_id,
      price: row.price,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      product: {
        id: row.product_id,
        name: row.product_name,
        description: row.product_description,
        imageId: row.product_image_id,
        imageUrl: row.product_image_url,
      },
      category: row.category_id ? {
        id: row.category_id,
        name: row.category_name,
      } : null,
    }, 201);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error adding product to catalog', { error });
    return c.json({ error: 'Failed to add product to catalog' }, 500);
  }
});

// Update catalog product
const updateCatalogProductRoute = createRoute({
  method: 'patch',
  path: '/catalogs/{catalogId}/products/{catalogProductId}',
  summary: 'Update a product in a catalog',
  tags: ['Catalog Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      catalogProductId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateCatalogProductSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Catalog product updated',
      content: {
        'application/json': {
          schema: catalogProductSchema,
        },
      },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog product not found' },
  },
});

app.openapi(updateCatalogProductRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { catalogId, catalogProductId } = c.req.param();
    const body = await c.req.json();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    // Verify category if provided
    if (body.categoryId !== undefined && body.categoryId !== null) {
      const categoryRows = await query(
        'SELECT id FROM categories WHERE id = $1 AND catalog_id = $2',
        [body.categoryId, catalogId]
      );
      if (categoryRows.length === 0) {
        return c.json({ error: 'Category not found or does not belong to this catalog' }, 400);
      }
    }

    // Build update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (body.categoryId !== undefined) {
      updates.push(`category_id = $${paramCount++}`);
      values.push(body.categoryId);
    }
    if (body.price !== undefined) {
      updates.push(`price = $${paramCount++}`);
      values.push(body.price);
    }
    if (body.sortOrder !== undefined) {
      updates.push(`sort_order = $${paramCount++}`);
      values.push(body.sortOrder);
    }
    if (body.isActive !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      values.push(body.isActive);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    values.push(catalogProductId, catalogId);

    const rows = await query(
      `UPDATE catalog_products
       SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramCount++} AND catalog_id = $${paramCount++}
       RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return c.json({ error: 'Catalog product not found' }, 404);
    }

    // Get product and category details for response
    const detailRows = await query(
      `SELECT
        cp.*,
        p.name as product_name,
        p.description as product_description,
        p.image_id as product_image_id,
        p.image_url as product_image_url,
        cat.name as category_name
       FROM catalog_products cp
       JOIN products p ON cp.product_id = p.id
       LEFT JOIN categories cat ON cp.category_id = cat.id
       WHERE cp.id = $1`,
      [catalogProductId]
    );

    const row = detailRows[0] as any;

    // Emit socket event
    socketService.emitToOrganization(
      payload.organizationId,
      SocketEvents.CATALOG_UPDATED,
      { catalogId, type: 'product_updated' }
    );

    return c.json({
      id: row.id,
      catalogId: row.catalog_id,
      productId: row.product_id,
      categoryId: row.category_id,
      price: row.price,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      product: {
        id: row.product_id,
        name: row.product_name,
        description: row.product_description,
        imageId: row.product_image_id,
        imageUrl: row.product_image_url,
      },
      category: row.category_id ? {
        id: row.category_id,
        name: row.category_name,
      } : null,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error updating catalog product', { error });
    return c.json({ error: 'Failed to update catalog product' }, 500);
  }
});

// Remove product from catalog
const removeProductFromCatalogRoute = createRoute({
  method: 'delete',
  path: '/catalogs/{catalogId}/products/{catalogProductId}',
  summary: 'Remove a product from a catalog',
  tags: ['Catalog Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      catalogProductId: z.string().uuid(),
    }),
  },
  responses: {
    204: { description: 'Product removed from catalog' },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog product not found' },
  },
});

app.openapi(removeProductFromCatalogRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { catalogId, catalogProductId } = c.req.param();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    const rows = await query(
      'DELETE FROM catalog_products WHERE id = $1 AND catalog_id = $2 RETURNING id',
      [catalogProductId, catalogId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'Catalog product not found' }, 404);
    }

    // Emit socket event
    socketService.emitToOrganization(
      payload.organizationId,
      SocketEvents.CATALOG_UPDATED,
      { catalogId, type: 'product_removed' }
    );

    return c.body(null, 204);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error removing product from catalog', { error });
    return c.json({ error: 'Failed to remove product from catalog' }, 500);
  }
});

// Bulk add products to catalog
const bulkAddProductsRoute = createRoute({
  method: 'post',
  path: '/catalogs/{catalogId}/products/bulk',
  summary: 'Bulk add products to a catalog',
  tags: ['Catalog Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: bulkAddProductsSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Products added to catalog',
      content: {
        'application/json': {
          schema: z.object({
            added: z.number(),
            skipped: z.number(),
          }),
        },
      },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(bulkAddProductsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { catalogId } = c.req.param();
    const body = await c.req.json();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    let added = 0;
    let skipped = 0;

    for (const product of body.products) {
      try {
        // Verify product exists
        const productRows = await query(
          'SELECT id FROM products WHERE id = $1 AND organization_id = $2',
          [product.productId, payload.organizationId]
        );
        if (productRows.length === 0) {
          skipped++;
          continue;
        }

        // Check if already exists
        const existingRows = await query(
          'SELECT id FROM catalog_products WHERE catalog_id = $1 AND product_id = $2',
          [catalogId, product.productId]
        );
        if (existingRows.length > 0) {
          skipped++;
          continue;
        }

        // Add to catalog
        await query(
          `INSERT INTO catalog_products (catalog_id, product_id, category_id, price, sort_order, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            catalogId,
            product.productId,
            product.categoryId || null,
            product.price,
            product.sortOrder || 0,
            product.isActive !== undefined ? product.isActive : true,
          ]
        );
        added++;
      } catch (err) {
        logger.error('Error adding product in bulk operation', { error: err, productId: product.productId });
        skipped++;
      }
    }

    // Emit socket event
    socketService.emitToOrganization(
      payload.organizationId,
      SocketEvents.CATALOG_UPDATED,
      { catalogId, type: 'products_bulk_added', added }
    );

    return c.json({ added, skipped }, 201);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error bulk adding products to catalog', { error });
    return c.json({ error: 'Failed to bulk add products to catalog' }, 500);
  }
});

// Reorder products in catalog
const reorderProductsSchema = z.object({
  productOrders: z.array(z.object({
    catalogProductId: z.string().uuid(),
    sortOrder: z.number().int().min(0),
  })),
});

const reorderProductsRoute = createRoute({
  method: 'post',
  path: '/catalogs/{catalogId}/products/reorder',
  summary: 'Reorder products within a catalog',
  tags: ['Catalog Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: reorderProductsSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Products reordered successfully',
      content: {
        'application/json': {
          schema: z.object({ success: z.boolean() }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(reorderProductsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { catalogId } = c.req.param();
    const body = await c.req.json();

    await verifyCatalogOwnership(catalogId, payload.organizationId);

    // Update sort orders in batch
    for (const { catalogProductId, sortOrder } of body.productOrders) {
      await query(
        'UPDATE catalog_products SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND catalog_id = $3',
        [sortOrder, catalogProductId, catalogId]
      );
    }

    logger.info('Products reordered', { catalogId, count: body.productOrders.length });

    // Emit socket event
    socketService.emitToOrganization(
      payload.organizationId,
      SocketEvents.CATALOG_UPDATED,
      { catalogId, type: 'products_reordered' }
    );

    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Catalog not found') {
      return c.json({ error: 'Catalog not found' }, 404);
    }
    logger.error('Error reordering products', { error });
    return c.json({ error: 'Failed to reorder products' }, 500);
  }
});

export default app;
