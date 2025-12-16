import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { Product, Catalog } from '../db/models';
import { logger } from '../utils/logger';
import { imageService } from '../services/images';

const app = new OpenAPIHono();

// Schema definitions
const productSchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  imageId: z.string().nullable(),
  imageUrl: z.string().nullable(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  price: z.number().min(0),
  imageUrl: z.string().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  price: z.number().min(0).optional(),
  imageUrl: z.string().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().optional(),
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

// Helper to verify catalog belongs to organization
async function verifyCatalogOwnership(catalogId: string, organizationId: string): Promise<Catalog | null> {
  const rows = await query<Catalog>(
    'SELECT * FROM catalogs WHERE id = $1 AND organization_id = $2',
    [catalogId, organizationId]
  );
  return rows[0] || null;
}

// List products for a catalog
const listProductsRoute = createRoute({
  method: 'get',
  path: '/catalogs/{catalogId}/products',
  summary: 'List all products in a catalog',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'List of products',
      content: {
        'application/json': {
          schema: z.array(productSchema),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(listProductsRoute, async (c) => {
  const { catalogId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Verify catalog ownership
    const catalog = await verifyCatalogOwnership(catalogId, payload.organizationId);
    if (!catalog) {
      return c.json({ error: 'Catalog not found' }, 404);
    }

    const rows = await query<Product & { category_name: string | null }>(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.catalog_id = $1 AND p.organization_id = $2
       ORDER BY p.sort_order ASC, p.created_at DESC`,
      [catalogId, payload.organizationId]
    );

    return c.json(rows.map(row => ({
      id: row.id,
      catalogId: row.catalog_id,
      name: row.name,
      description: row.description,
      price: row.price,
      imageId: row.image_id,
      imageUrl: row.image_url,
      categoryId: row.category_id,
      categoryName: row.category_name,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing products', { error, catalogId });
    return c.json({ error: 'Failed to list products' }, 500);
  }
});

// Get single product
const getProductRoute = createRoute({
  method: 'get',
  path: '/catalogs/{catalogId}/products/{productId}',
  summary: 'Get a product by ID',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      productId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Product details',
      content: {
        'application/json': {
          schema: productSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Product not found' },
  },
});

app.openapi(getProductRoute, async (c) => {
  const { catalogId, productId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const rows = await query<Product & { category_name: string | null }>(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = $1 AND p.catalog_id = $2 AND p.organization_id = $3`,
      [productId, catalogId, payload.organizationId]
    );

    if (!rows[0]) {
      return c.json({ error: 'Product not found' }, 404);
    }

    const row = rows[0];
    return c.json({
      id: row.id,
      catalogId: row.catalog_id,
      name: row.name,
      description: row.description,
      price: row.price,
      imageId: row.image_id,
      imageUrl: row.image_url,
      categoryId: row.category_id,
      categoryName: row.category_name,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error fetching product', { error, catalogId, productId });
    return c.json({ error: 'Failed to fetch product' }, 500);
  }
});

// Create product
const createProductRoute = createRoute({
  method: 'post',
  path: '/catalogs/{catalogId}/products',
  summary: 'Create a new product',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: createProductSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Product created',
      content: {
        'application/json': {
          schema: productSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Catalog not found' },
  },
});

app.openapi(createProductRoute, async (c) => {
  const { catalogId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const contentType = c.req.header('Content-Type') || '';
    let body: any;
    let imageFile: File | null = null;

    // Parse based on content type
    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      body = {
        name: formData.get('name') as string,
        description: formData.get('description') as string || null,
        price: parseInt(formData.get('price') as string, 10),
        categoryId: formData.get('categoryId') as string || null,
        isActive: formData.get('isActive') === 'true',
      };
      const file = formData.get('image');
      if (file instanceof File) {
        imageFile = file;
      }
      logger.info('Parsed FormData', { body, hasImage: !!imageFile });
    } else {
      body = await c.req.json();
      logger.info('Parsed JSON', { body });
    }

    logger.info('Creating product', { catalogId, body, hasImage: !!imageFile });

    // Verify catalog ownership
    const catalog = await verifyCatalogOwnership(catalogId, payload.organizationId);
    if (!catalog) {
      return c.json({ error: 'Catalog not found' }, 404);
    }

    // Upload image if provided
    let imageId: string | null = null;
    let imageUrl: string | null = null;
    if (imageFile) {
      if (!imageService.isConfigured()) {
        return c.json({ error: 'Image uploads not configured' }, 500);
      }
      const buffer = await imageFile.arrayBuffer();
      const result = await imageService.upload(buffer, imageFile.type);
      imageId = result.id;
      imageUrl = result.url;
      logger.info('Image uploaded for product', { imageId });
    }

    // Get max sort order
    const maxOrderResult = await query<{ max: number }>(
      'SELECT COALESCE(MAX(sort_order), -1) as max FROM products WHERE catalog_id = $1',
      [catalogId]
    );
    const sortOrder = (maxOrderResult[0]?.max ?? -1) + 1;

    const rows = await query<Product>(
      `INSERT INTO products (catalog_id, organization_id, name, description, price, image_id, image_url, category_id, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        catalogId,
        payload.organizationId,
        body.name,
        body.description || null,
        body.price,
        imageId,
        imageUrl,
        body.categoryId || null,
        body.isActive ?? true,
        sortOrder,
      ]
    );

    const row = rows[0];
    logger.info('Product created', { productId: row.id, catalogId });

    // Get category name if categoryId was provided
    let categoryName: string | null = null;
    if (row.category_id) {
      const catRows = await query<{ name: string }>('SELECT name FROM categories WHERE id = $1', [row.category_id]);
      categoryName = catRows[0]?.name || null;
    }

    return c.json({
      id: row.id,
      catalogId: row.catalog_id,
      name: row.name,
      description: row.description,
      price: row.price,
      imageId: row.image_id,
      imageUrl: row.image_url,
      categoryId: row.category_id,
      categoryName,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }, 201);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error creating product', {
      catalogId,
      errorMessage: error.message,
      errorStack: error.stack,
      errorName: error.name,
    });
    return c.json({ error: 'Failed to create product' }, 500);
  }
});

// Update product
const updateProductRoute = createRoute({
  method: 'put',
  path: '/catalogs/{catalogId}/products/{productId}',
  summary: 'Update a product',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      productId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateProductSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Product updated',
      content: {
        'application/json': {
          schema: productSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Product not found' },
  },
});

app.openapi(updateProductRoute, async (c) => {
  const { catalogId, productId } = c.req.param();

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
    if (body.price !== undefined) {
      updates.push(`price = $${paramCount}`);
      values.push(body.price);
      paramCount++;
    }
    if (body.imageUrl !== undefined) {
      updates.push(`image_url = $${paramCount}`);
      values.push(body.imageUrl);
      paramCount++;
    }
    if (body.categoryId !== undefined) {
      updates.push(`category_id = $${paramCount}`);
      values.push(body.categoryId);
      paramCount++;
    }
    if (body.isActive !== undefined) {
      updates.push(`is_active = $${paramCount}`);
      values.push(body.isActive);
      paramCount++;
    }
    if (body.sortOrder !== undefined) {
      updates.push(`sort_order = $${paramCount}`);
      values.push(body.sortOrder);
      paramCount++;
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    updates.push(`updated_at = NOW()`);
    values.push(productId, catalogId, payload.organizationId);

    const rows = await query<Product & { category_name: string | null }>(
      `UPDATE products
       SET ${updates.join(', ')}
       WHERE id = $${paramCount} AND catalog_id = $${paramCount + 1} AND organization_id = $${paramCount + 2}
       RETURNING *,
         (SELECT name FROM categories WHERE id = products.category_id) as category_name`,
      values
    );

    if (!rows[0]) {
      return c.json({ error: 'Product not found' }, 404);
    }

    const row = rows[0];
    logger.info('Product updated', { productId: row.id });

    return c.json({
      id: row.id,
      catalogId: row.catalog_id,
      name: row.name,
      description: row.description,
      price: row.price,
      imageId: row.image_id,
      imageUrl: row.image_url,
      categoryId: row.category_id,
      categoryName: row.category_name,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating product', { error, catalogId, productId });
    return c.json({ error: 'Failed to update product' }, 500);
  }
});

// Delete product
const deleteProductRoute = createRoute({
  method: 'delete',
  path: '/catalogs/{catalogId}/products/{productId}',
  summary: 'Delete a product',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      catalogId: z.string().uuid(),
      productId: z.string().uuid(),
    }),
  },
  responses: {
    200: { description: 'Product deleted' },
    401: { description: 'Unauthorized' },
    404: { description: 'Product not found' },
  },
});

app.openapi(deleteProductRoute, async (c) => {
  const { catalogId, productId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const result = await query(
      `DELETE FROM products
       WHERE id = $1 AND catalog_id = $2 AND organization_id = $3
       RETURNING id`,
      [productId, catalogId, payload.organizationId]
    );

    if (result.length === 0) {
      return c.json({ error: 'Product not found' }, 404);
    }

    logger.info('Product deleted', { productId, catalogId });
    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error deleting product', { error, catalogId, productId });
    return c.json({ error: 'Failed to delete product' }, 500);
  }
});

export default app;
