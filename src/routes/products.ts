import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { Product } from '../db/models';
import { logger } from '../utils/logger';
import { imageService } from '../services/images';
import { socketService, SocketEvents } from '../services/socket';

const app = new OpenAPIHono();

// Schema definitions (simplified - no catalog-specific fields)
const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  imageId: z.string().nullable(),
  imageUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
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

// List all products in organization (product library)
const listProductsRoute = createRoute({
  method: 'get',
  path: '/products',
  summary: 'List all products in organization',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
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
  },
});

app.openapi(listProductsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const rows = await query<Product>(
      `SELECT *
       FROM products
       WHERE organization_id = $1
       ORDER BY name ASC`,
      [payload.organizationId]
    );

    return c.json(rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      imageId: row.image_id,
      imageUrl: row.image_url,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })));
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing products', { error });
    return c.json({ error: 'Failed to list products' }, 500);
  }
});

// Get single product
const getProductRoute = createRoute({
  method: 'get',
  path: '/products/{productId}',
  summary: 'Get a product by ID',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
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
  const { productId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const rows = await query<Product>(
      'SELECT * FROM products WHERE id = $1 AND organization_id = $2',
      [productId, payload.organizationId]
    );

    if (!rows[0]) {
      return c.json({ error: 'Product not found' }, 404);
    }

    const row = rows[0];
    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      imageId: row.image_id,
      imageUrl: row.image_url,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error fetching product', { error, productId });
    return c.json({ error: 'Failed to fetch product' }, 500);
  }
});

// Create product
const createProductRoute = createRoute({
  method: 'post',
  path: '/products',
  summary: 'Create a new product',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
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
  },
});

app.openapi(createProductRoute, async (c) => {
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

    logger.info('Creating product', { body, hasImage: !!imageFile });

    // Upload image if provided
    let imageId: string | null = null;
    let imageUrl: string | null = null;
    if (imageFile) {
      if (!imageService.isConfigured()) {
        return c.json({ error: 'Image uploads not configured' }, 500);
      }
      const buffer = await imageFile.arrayBuffer();
      const result = await imageService.upload(buffer, imageFile.type, { imageType: 'product' });
      imageId = result.id;
      imageUrl = result.url;
      logger.info('Image uploaded for product', { imageId });
    }

    const rows = await query<Product>(
      `INSERT INTO products (organization_id, name, description, image_id, image_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        payload.organizationId,
        body.name,
        body.description || null,
        imageId,
        imageUrl,
      ]
    );

    const row = rows[0];
    logger.info('Product created', { productId: row.id });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.PRODUCT_CREATED, {
      productId: row.id,
      name: row.name,
    });

    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      imageId: row.image_id,
      imageUrl: row.image_url,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }, 201);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error creating product', {
      errorMessage: error.message,
      errorStack: error.stack,
      errorName: error.name,
    });
    return c.json({ error: 'Failed to create product' }, 500);
  }
});

// Update product
const updateProductRoute = createRoute({
  method: 'patch',
  path: '/products/{productId}',
  summary: 'Update a product',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
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
  const { productId } = c.req.param();

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

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    updates.push(`updated_at = NOW()`);
    values.push(productId, payload.organizationId);

    const rows = await query<Product>(
      `UPDATE products
       SET ${updates.join(', ')}
       WHERE id = $${paramCount} AND organization_id = $${paramCount + 1}
       RETURNING *`,
      values
    );

    if (!rows[0]) {
      return c.json({ error: 'Product not found' }, 404);
    }

    const row = rows[0];
    logger.info('Product updated', { productId: row.id });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.PRODUCT_UPDATED, {
      productId: row.id,
      name: row.name,
    });

    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      imageId: row.image_id,
      imageUrl: row.image_url,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating product', { error, productId });
    return c.json({ error: 'Failed to update product' }, 500);
  }
});

// Update product image
const updateProductImageRoute = createRoute({
  method: 'post',
  path: '/products/{productId}/image',
  summary: 'Upload or update product image',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      productId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Image updated',
      content: {
        'application/json': {
          schema: productSchema,
        },
      },
    },
    400: { description: 'Bad request' },
    401: { description: 'Unauthorized' },
    404: { description: 'Product not found' },
    500: { description: 'Image upload failed' },
  },
});

app.openapi(updateProductImageRoute, async (c) => {
  const { productId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    if (!imageService.isConfigured()) {
      return c.json({ error: 'Image uploads not configured' }, 500);
    }

    const formData = await c.req.formData();
    const file = formData.get('image');

    if (!(file instanceof File)) {
      return c.json({ error: 'No image file provided' }, 400);
    }

    // Upload new image
    const buffer = await file.arrayBuffer();
    const result = await imageService.upload(buffer, file.type, { imageType: 'product' });

    // Update product with new image
    const rows = await query<Product>(
      `UPDATE products
       SET image_id = $1, image_url = $2, updated_at = NOW()
       WHERE id = $3 AND organization_id = $4
       RETURNING *`,
      [result.id, result.url, productId, payload.organizationId]
    );

    if (!rows[0]) {
      return c.json({ error: 'Product not found' }, 404);
    }

    const row = rows[0];
    logger.info('Product image updated', { productId: row.id, imageId: result.id });

    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      imageId: row.image_id,
      imageUrl: row.image_url,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating product image', { error, productId });
    return c.json({ error: 'Failed to update product image' }, 500);
  }
});

// Delete product
const deleteProductRoute = createRoute({
  method: 'delete',
  path: '/products/{productId}',
  summary: 'Delete a product',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      productId: z.string().uuid(),
    }),
  },
  responses: {
    204: { description: 'Product deleted' },
    401: { description: 'Unauthorized' },
    404: { description: 'Product not found' },
  },
});

app.openapi(deleteProductRoute, async (c) => {
  const { productId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const result = await query(
      'DELETE FROM products WHERE id = $1 AND organization_id = $2 RETURNING id',
      [productId, payload.organizationId]
    );

    if (result.length === 0) {
      return c.json({ error: 'Product not found' }, 404);
    }

    logger.info('Product deleted', { productId });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.PRODUCT_DELETED, {
      productId,
    });

    return c.body(null, 204);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error deleting product', { error, productId });
    return c.json({ error: 'Failed to delete product' }, 500);
  }
});

export default app;
