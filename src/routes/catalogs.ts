import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query, transaction } from '../db';
import { Catalog, Category, CatalogProduct, Product } from '../db/models';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';
import { imageService } from '../services/images';

const app = new OpenAPIHono();

// Schema definitions
const layoutTypeSchema = z.enum(['grid', 'list', 'large-grid', 'compact']);
const preorderPaymentModeSchema = z.enum(['pay_now', 'pay_at_pickup', 'both']);

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
  // Preorder settings
  preorderEnabled: z.boolean(),
  slug: z.string().nullable(),
  preorderPaymentMode: preorderPaymentModeSchema,
  pickupInstructions: z.string().nullable(),
  estimatedPrepTime: z.number(),
  productCount: z.number(),
  isLocked: z.boolean().optional(),
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
  // Preorder settings
  preorderEnabled: z.boolean().optional().default(false),
  slug: z.string().max(200).nullable().optional(),
  preorderPaymentMode: preorderPaymentModeSchema.optional().default('both'),
  pickupInstructions: z.string().max(1000).nullable().optional(),
  estimatedPrepTime: z.number().int().min(1).max(180).optional().default(10),
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
  // Preorder settings
  preorderEnabled: z.boolean().optional(),
  slug: z.string().max(200).nullable().optional(),
  preorderPaymentMode: preorderPaymentModeSchema.optional(),
  pickupInstructions: z.string().max(1000).nullable().optional(),
  estimatedPrepTime: z.number().int().min(1).max(180).optional(),
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

// Helper to check if a catalog is locked based on subscription tier
// Free/starter tier: only the OLDEST catalog is accessible (last when sorted by created_at DESC)
async function checkCatalogAccess(
  catalogId: string,
  organizationId: string
): Promise<{ allowed: boolean; reason?: string }> {
  // Get subscription tier
  const subscriptionResult = await query<{ tier: string; status: string }>(
    `SELECT tier, status FROM subscriptions
     WHERE organization_id = $1 AND status IN ('active', 'trialing')
     LIMIT 1`,
    [organizationId]
  );

  // No active subscription - allow access (will be handled by other checks)
  if (subscriptionResult.length === 0) {
    return { allowed: true };
  }

  const { tier } = subscriptionResult[0];

  // Pro and Enterprise tiers have full access
  if (tier !== 'starter' && tier !== 'free') {
    return { allowed: true };
  }

  // For free/starter tier, check if this is the oldest (allowed) catalog
  // Get all catalogs sorted by created_at DESC (newest first)
  const catalogsResult = await query<{ id: string }>(
    `SELECT id FROM catalogs
     WHERE organization_id = $1
     ORDER BY created_at DESC`,
    [organizationId]
  );

  // If only 1 catalog, it's allowed
  if (catalogsResult.length <= 1) {
    return { allowed: true };
  }

  // The LAST catalog in this list (oldest) is the allowed one
  const allowedCatalogId = catalogsResult[catalogsResult.length - 1].id;

  if (catalogId === allowedCatalogId) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: 'This catalog is locked. Free tier accounts can only access their oldest catalog. Upgrade to Pro to unlock all catalogs.',
  };
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

    // For 'user' role (staff), filter by assigned catalogs
    // For 'owner' and 'admin' roles, show all catalogs
    let rows: (Catalog & { product_count: number })[];

    if (payload.role === 'user') {
      // Staff with 'user' role - only show assigned catalogs
      rows = await query<Catalog & { product_count: number }>(
        `SELECT c.*,
          (SELECT COUNT(*) FROM catalog_products WHERE catalog_id = c.id)::int as product_count
         FROM catalogs c
         INNER JOIN user_catalogs uc ON c.id = uc.catalog_id
         WHERE c.organization_id = $1 AND uc.user_id = $2
         ORDER BY c.created_at DESC`,
        [payload.organizationId, payload.userId]
      );
    } else {
      // Owner/Admin - show all catalogs
      rows = await query<Catalog & { product_count: number }>(
        `SELECT c.*,
          (SELECT COUNT(*) FROM catalog_products WHERE catalog_id = c.id)::int as product_count
         FROM catalogs c
         WHERE c.organization_id = $1
         ORDER BY c.created_at DESC`,
        [payload.organizationId]
      );
    }

    // Determine which catalogs are locked based on subscription tier
    const subscriptionResult = await query<{ tier: string; status: string }>(
      `SELECT tier, status FROM subscriptions
       WHERE organization_id = $1 AND status IN ('active', 'trialing')
       LIMIT 1`,
      [payload.organizationId]
    );

    let lockedCatalogIds: Set<string> = new Set();
    logger.info('Catalog list - subscription check', {
      organizationId: payload.organizationId,
      subscription: subscriptionResult[0] || 'none',
      catalogCount: rows.length,
    });

    if (subscriptionResult.length > 0) {
      const { tier } = subscriptionResult[0];
      if ((tier === 'starter' || tier === 'free') && rows.length > 1) {
        // For free/starter tier, all except the oldest catalog are locked
        // rows are sorted by created_at DESC, so the last one is the oldest (unlocked)
        const unlockedId = rows[rows.length - 1].id;
        lockedCatalogIds = new Set(rows.filter(r => r.id !== unlockedId).map(r => r.id));
        logger.info('Catalog locking applied', {
          tier,
          unlockedId,
          lockedIds: Array.from(lockedCatalogIds),
          catalogOrder: rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at })),
        });
      }
    }

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
      // Preorder settings
      preorderEnabled: (row as any).preorder_enabled ?? false,
      slug: (row as any).slug ?? null,
      preorderPaymentMode: (row as any).preorder_payment_mode ?? 'both',
      pickupInstructions: (row as any).pickup_instructions ?? null,
      estimatedPrepTime: (row as any).estimated_prep_time ?? 10,
      productCount: row.product_count || 0,
      isLocked: lockedCatalogIds.has(row.id),
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

    // Check if catalog is locked based on subscription tier
    const accessCheck = await checkCatalogAccess(id, payload.organizationId);
    if (!accessCheck.allowed) {
      return c.json({
        error: accessCheck.reason,
        code: 'CATALOG_LOCKED'
      }, 403);
    }

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
      // Preorder settings
      preorderEnabled: (row as any).preorder_enabled ?? false,
      slug: (row as any).slug ?? null,
      preorderPaymentMode: (row as any).preorder_payment_mode ?? 'both',
      pickupInstructions: (row as any).pickup_instructions ?? null,
      estimatedPrepTime: (row as any).estimated_prep_time ?? 10,
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

    // Check subscription tier - free/starter can only have 1 catalog
    const subscriptionResult = await query<{ tier: string; status: string }>(
      `SELECT tier, status FROM subscriptions
       WHERE organization_id = $1 AND status IN ('active', 'trialing')
       LIMIT 1`,
      [payload.organizationId]
    );

    if (subscriptionResult.length > 0) {
      const { tier } = subscriptionResult[0];
      if (tier === 'starter' || tier === 'free') {
        // Check if they already have a catalog
        const catalogCount = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM catalogs WHERE organization_id = $1`,
          [payload.organizationId]
        );
        if (parseInt(catalogCount[0].count) >= 1) {
          return c.json({
            error: 'Free tier accounts can only have one catalog. Upgrade to Pro to create additional catalogs.',
            code: 'CATALOG_LIMIT_REACHED'
          }, 403);
        }
      }
    }

    const rows = await query<Catalog>(
      `INSERT INTO catalogs (
        organization_id, name, description, location, date, is_active, show_tip_screen,
        prompt_for_email, tip_percentages, allow_custom_tip, tax_rate, layout_type,
        preorder_enabled, slug, preorder_payment_mode, pickup_instructions, estimated_prep_time
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
        body.preorderEnabled ?? false,
        body.slug || null,
        body.preorderPaymentMode || 'both',
        body.pickupInstructions || null,
        body.estimatedPrepTime ?? 10,
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
      // Preorder settings
      preorderEnabled: (row as any).preorder_enabled ?? false,
      slug: (row as any).slug ?? null,
      preorderPaymentMode: (row as any).preorder_payment_mode ?? 'both',
      pickupInstructions: (row as any).pickup_instructions ?? null,
      estimatedPrepTime: (row as any).estimated_prep_time ?? 10,
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

    // Check if catalog is locked based on subscription tier
    const accessCheck = await checkCatalogAccess(id, payload.organizationId);
    if (!accessCheck.allowed) {
      return c.json({
        error: accessCheck.reason,
        code: 'CATALOG_LOCKED'
      }, 403);
    }

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
    // Preorder settings
    if (body.preorderEnabled !== undefined) {
      updates.push(`preorder_enabled = $${paramCount}`);
      values.push(body.preorderEnabled);
      paramCount++;
    }
    if (body.slug !== undefined) {
      updates.push(`slug = $${paramCount}`);
      values.push(body.slug);
      paramCount++;
    }
    if (body.preorderPaymentMode !== undefined) {
      updates.push(`preorder_payment_mode = $${paramCount}`);
      values.push(body.preorderPaymentMode);
      paramCount++;
    }
    if (body.pickupInstructions !== undefined) {
      updates.push(`pickup_instructions = $${paramCount}`);
      values.push(body.pickupInstructions);
      paramCount++;
    }
    if (body.estimatedPrepTime !== undefined) {
      updates.push(`estimated_prep_time = $${paramCount}`);
      values.push(body.estimatedPrepTime);
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
    // Emit to public namespace for marketing site menu pages
    socketService.emitToCatalog(row.id, SocketEvents.CATALOG_UPDATED, {
      catalogId: row.id,
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
      // Preorder settings
      preorderEnabled: (row as any).preorder_enabled ?? false,
      slug: (row as any).slug ?? null,
      preorderPaymentMode: (row as any).preorder_payment_mode ?? 'both',
      pickupInstructions: (row as any).pickup_instructions ?? null,
      estimatedPrepTime: (row as any).estimated_prep_time ?? 10,
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

    // Only owners can delete catalogs
    if (payload.role !== 'owner') {
      return c.json({ error: 'Only owners can delete catalogs' }, 403);
    }

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
    // Emit to public namespace for marketing site menu pages
    socketService.emitToCatalog(id, SocketEvents.CATALOG_DELETED, {
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

// Duplicate catalog
const duplicateCatalogRoute = createRoute({
  method: 'post',
  path: '/catalogs/{id}/duplicate',
  summary: 'Duplicate a catalog with all its categories and products',
  tags: ['Catalogs'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(100).optional(),
          }).optional(),
        },
      },
      required: false,
    },
  },
  responses: {
    201: {
      description: 'Catalog duplicated',
      content: {
        'application/json': {
          schema: catalogSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Original catalog not found' },
  },
});

app.openapi(duplicateCatalogRoute, async (c) => {
  const { id: originalId } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Check if catalog is locked based on subscription tier
    const accessCheck = await checkCatalogAccess(originalId, payload.organizationId);
    if (!accessCheck.allowed) {
      return c.json({
        error: accessCheck.reason,
        code: 'CATALOG_LOCKED'
      }, 403);
    }

    const body = await c.req.json().catch(() => ({}));

    return await transaction(async (client) => {
      // Fetch the original catalog
      const originalCatalog = await client.query(
        'SELECT * FROM catalogs WHERE id = $1 AND organization_id = $2',
        [originalId, payload.organizationId]
      ) as { rows: Catalog[] };

      if (originalCatalog.rows.length === 0) {
        return c.json({ error: 'Catalog not found' }, 404);
      }

      const original = originalCatalog.rows[0];
      const newName = body.name || `${original.name} (Copy)`;

      // Create the new catalog
      const newCatalogResult = await client.query(
        `INSERT INTO catalogs (
          organization_id, name, description, location, date, is_active,
          show_tip_screen, prompt_for_email, tip_percentages, allow_custom_tip,
          tax_rate, layout_type
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          payload.organizationId,
          newName,
          original.description,
          original.location,
          original.date,
          original.is_active,
          original.show_tip_screen,
          (original as any).prompt_for_email,
          JSON.stringify((original as any).tip_percentages || [15, 18, 20, 25]),
          (original as any).allow_custom_tip,
          (original as any).tax_rate || 0,
          (original as any).layout_type || 'grid',
        ]
      ) as { rows: Catalog[] };

      const newCatalog = newCatalogResult.rows[0];

      // Fetch and duplicate categories, keeping track of old -> new ID mapping
      const originalCategories = await client.query(
        'SELECT * FROM categories WHERE catalog_id = $1 ORDER BY sort_order ASC',
        [originalId]
      ) as { rows: Category[] };

      const categoryIdMap = new Map<string, string>(); // old ID -> new ID

      for (const category of originalCategories.rows) {
        const newCategoryResult = await client.query(
          `INSERT INTO categories (
            catalog_id, organization_id, name, description, icon, sort_order, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *`,
          [
            newCatalog.id,
            payload.organizationId,
            category.name,
            category.description,
            category.icon,
            category.sort_order,
            category.is_active,
          ]
        ) as { rows: Category[] };
        categoryIdMap.set(category.id, newCategoryResult.rows[0].id);
      }

      // Fetch catalog products with their product details
      const originalCatalogProducts = await client.query(
        `SELECT cp.*, p.name as product_name, p.description as product_description, p.image_id as product_image_id
         FROM catalog_products cp
         JOIN products p ON cp.product_id = p.id
         WHERE cp.catalog_id = $1
         ORDER BY cp.sort_order ASC`,
        [originalId]
      ) as { rows: (CatalogProduct & { product_name: string; product_description: string | null; product_image_id: string | null })[] };

      // Duplicate each product and its catalog_product entry
      for (const catalogProduct of originalCatalogProducts.rows) {
        // Duplicate the image if it exists
        let newImageId: string | null = null;
        if (catalogProduct.product_image_id) {
          const duplicatedImage = await imageService.duplicate(catalogProduct.product_image_id);
          if (duplicatedImage) {
            newImageId = duplicatedImage.id;
          }
        }

        // Create a new product in the product library
        const newProductResult = await client.query(
          `INSERT INTO products (organization_id, name, description, image_id, image_url)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            payload.organizationId,
            catalogProduct.product_name,
            catalogProduct.product_description,
            newImageId,
            newImageId ? imageService.getUrl(newImageId) : null,
          ]
        ) as { rows: Product[] };

        const newProduct = newProductResult.rows[0];

        // Map the category ID to the new catalog's category
        const newCategoryId = catalogProduct.category_id
          ? categoryIdMap.get(catalogProduct.category_id) || null
          : null;

        // Create the catalog_product entry
        await client.query(
          `INSERT INTO catalog_products (
            catalog_id, product_id, category_id, price, sort_order, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            newCatalog.id,
            newProduct.id,
            newCategoryId,
            catalogProduct.price,
            catalogProduct.sort_order,
            catalogProduct.is_active,
          ]
        );
      }

      // Duplicate revenue splits if any
      await client.query(
        `INSERT INTO revenue_splits (
          catalog_id, organization_id, recipient_name, recipient_type, percentage, notes, is_active
        )
        SELECT $1, organization_id, recipient_name, recipient_type, percentage, notes, is_active
        FROM revenue_splits
        WHERE catalog_id = $2`,
        [newCatalog.id, originalId]
      );

      logger.info('Catalog duplicated', {
        originalCatalogId: originalId,
        newCatalogId: newCatalog.id,
        categoriesDuplicated: originalCategories.rows.length,
        productsDuplicated: originalCatalogProducts.rows.length,
      });

      // Emit socket event for real-time updates
      socketService.emitToOrganization(payload.organizationId, SocketEvents.CATALOG_CREATED, {
        catalogId: newCatalog.id,
        name: newCatalog.name,
      });

      // Get product count for response
      const productCountResult = await client.query(
        'SELECT COUNT(*) as count FROM catalog_products WHERE catalog_id = $1',
        [newCatalog.id]
      );

      return c.json({
        id: newCatalog.id,
        name: newCatalog.name,
        description: newCatalog.description,
        location: newCatalog.location,
        date: newCatalog.date,
        isActive: newCatalog.is_active,
        showTipScreen: newCatalog.show_tip_screen,
        promptForEmail: (newCatalog as any).prompt_for_email ?? true,
        tipPercentages: (newCatalog as any).tip_percentages ?? [15, 18, 20, 25],
        allowCustomTip: (newCatalog as any).allow_custom_tip ?? true,
        taxRate: parseFloat((newCatalog as any).tax_rate) || 0,
        layoutType: (newCatalog as any).layout_type || 'grid',
        // Preorder settings - defaults for duplicated catalog (not copied from original)
        preorderEnabled: false,
        slug: null,
        preorderPaymentMode: 'both',
        pickupInstructions: null,
        estimatedPrepTime: 10,
        productCount: parseInt(productCountResult.rows[0].count) || 0,
        createdAt: newCatalog.created_at.toISOString(),
        updatedAt: newCatalog.updated_at.toISOString(),
      }, 201);
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error duplicating catalog', { error, catalogId: originalId });
    return c.json({ error: 'Failed to duplicate catalog' }, 500);
  }
});

export default app;
