import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../../db';
import { Organization } from '../../db/models';
import { logger } from '../../utils/logger';
import { socketService, SocketEvents } from '../../services/socket';
import { imageService } from '../../services/images';

const app = new OpenAPIHono();

// Get organization by ID
const getOrganizationRoute = createRoute({
  method: 'get',
  path: '/organizations/{id}',
  summary: 'Get organization by ID',
  tags: ['Organizations'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Organization details',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            name: z.string(),
            stripeAccountId: z.string().nullable(),
            stripeOnboardingCompleted: z.boolean(),
            settings: z.record(z.any()),
            brandingLogoUrl: z.string().nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        },
      },
    },
    403: {
      description: 'Forbidden - user does not belong to this organization',
    },
    404: {
      description: 'Organization not found',
    },
  },
});

app.openapi(getOrganizationRoute, async (c) => {
  const { id } = c.req.param();
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    // Verify token and get user info
    logger.info('Starting organization fetch', { orgId: id, hasToken: !!token });
    
    const { authService } = await import('../../services/auth');
    logger.info('Auth service imported, verifying token...');
    
    const payload = await authService.verifyToken(token);
    logger.info('Token verified successfully', {
      userId: payload.userId,
      userOrgId: payload.organizationId,
      requestedOrgId: id
    });
    
    // Check if user belongs to this organization
    if (payload.organizationId !== id) {
      logger.warn('User attempted to access organization they do not belong to', {
        userId: payload.userId,
        requestedOrgId: id,
        userOrgId: payload.organizationId,
      });
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Get organization from database
    logger.info('Executing database query for organization', { orgId: id });
    
    const rows = await query<Organization>(
      'SELECT * FROM organizations WHERE id = $1',
      [id]
    );
    
    logger.info('Database query completed', { 
      orgId: id,
      rowCount: rows.length,
      hasRows: rows.length > 0
    });

    if (!rows[0]) {
      logger.warn('Organization not found in database', { orgId: id });
      return c.json({ error: 'Organization not found' }, 404);
    }

    const org = rows[0];
    logger.info('Organization data retrieved', { 
      orgId: org.id,
      orgName: org.name,
      hasCreatedAt: !!org.created_at,
      hasUpdatedAt: !!org.updated_at,
      createdAtType: typeof org.created_at,
      updatedAtType: typeof org.updated_at
    });

    logger.info('Organization fetched', { 
      organizationId: org.id,
      userId: payload.userId,
    });

    return c.json({
      id: org.id,
      name: org.name,
      stripeAccountId: org.stripe_account_id,
      stripeOnboardingCompleted: org.stripe_onboarding_completed,
      settings: org.settings,
      brandingLogoUrl: imageService.getUrl(org.branding_logo_id),
      createdAt: org.created_at.toISOString(),
      updatedAt: org.updated_at.toISOString(),
    });
  } catch (error: any) {
    logger.error('Error fetching organization - detailed', { 
      errorMessage: error?.message || 'Unknown error',
      errorType: error?.constructor?.name || 'Unknown',
      errorStack: error?.stack,
      orgId: id,
      error: JSON.stringify(error, null, 2)
    });
    
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    return c.json({ error: 'Failed to fetch organization' }, 500);
  }
});

// Update organization (supports both PUT and PATCH)
const updateOrganizationRoute = createRoute({
  method: 'patch',
  path: '/organizations/{id}',
  summary: 'Update organization details',
  tags: ['Organizations'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(2).optional(),
            settings: z.record(z.any()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Organization updated successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            name: z.string(),
            stripeAccountId: z.string().nullable(),
            stripeOnboardingCompleted: z.boolean(),
            settings: z.record(z.any()),
            brandingLogoUrl: z.string().nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        },
      },
    },
    403: {
      description: 'Forbidden - only owners can update organization',
    },
    404: {
      description: 'Organization not found',
    },
  },
});

app.openapi(updateOrganizationRoute, async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    // Verify token and get user info
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);
    
    // Check if user belongs to this organization
    if (payload.organizationId !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Only owners and admins can update organization
    if (payload.role !== 'owner' && payload.role !== 'admin') {
      return c.json({ error: 'Only organization owners and admins can update organization details' }, 403);
    }

    // Build update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (body.name !== undefined) {
      updates.push(`name = $${paramCount}`);
      values.push(body.name);
      paramCount++;
    }

    if (body.settings !== undefined) {
      // Merge new settings with existing settings instead of replacing
      updates.push(`settings = COALESCE(settings, '{}'::jsonb) || $${paramCount}::jsonb`);
      values.push(JSON.stringify(body.settings));
      paramCount++;
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const updateQuery = `
      UPDATE organizations 
      SET ${updates.join(', ')} 
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const rows = await query<Organization>(updateQuery, values);

    if (!rows[0]) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const org = rows[0];

    logger.info('Organization updated', {
      organizationId: org.id,
      userId: payload.userId,
      updates: Object.keys(body),
    });

    // Emit socket event to notify all connected clients in this org
    socketService.emitToOrganization(org.id, SocketEvents.ORGANIZATION_UPDATED, {
      organizationId: org.id,
      settings: org.settings,
      updatedBy: payload.userId,
      timestamp: new Date().toISOString(),
    });

    return c.json({
      id: org.id,
      name: org.name,
      stripeAccountId: org.stripe_account_id,
      stripeOnboardingCompleted: org.stripe_onboarding_completed,
      settings: org.settings,
      brandingLogoUrl: imageService.getUrl(org.branding_logo_id),
      createdAt: org.created_at.toISOString(),
      updatedAt: org.updated_at.toISOString(),
    });
  } catch (error) {
    logger.error('Error updating organization', { error, orgId: id });
    
    if (error instanceof Error && error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    return c.json({ error: 'Failed to update organization' }, 500);
  }
});

// Upload branding logo
const uploadBrandingLogoRoute = createRoute({
  method: 'post',
  path: '/organizations/{id}/branding-logo',
  summary: 'Upload or replace branding logo for customer-facing emails',
  tags: ['Organizations'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.any().openapi({ type: 'string', format: 'binary' }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Branding logo uploaded successfully',
      content: {
        'application/json': {
          schema: z.object({
            brandingLogoUrl: z.string(),
            brandingLogoId: z.string(),
          }),
        },
      },
    },
    400: { description: 'Invalid file or file too large' },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden - only owners/admins can upload' },
    503: { description: 'Image service not configured' },
  },
});

app.openapi(uploadBrandingLogoRoute, async (c) => {
  if (!imageService.isConfigured()) {
    return c.json({ error: 'Image upload service not available' }, 503);
  }

  const { id } = c.req.param();
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    if (payload.organizationId !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (payload.role !== 'owner' && payload.role !== 'admin') {
      return c.json({ error: 'Only owners and admins can upload branding logo' }, 403);
    }

    const formData = await c.req.formData();
    const file = formData.get('file');
    const isFileLike = file && typeof file === 'object' && 'arrayBuffer' in file && 'type' in file;

    if (!isFileLike) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const uploadedFile = file as Blob;
    const contentType = uploadedFile.type;

    if (!imageService.allowedTypes.includes(contentType)) {
      return c.json({ error: `Invalid file type: ${contentType}. Allowed: ${imageService.allowedTypes.join(', ')}` }, 400);
    }

    const buffer = await uploadedFile.arrayBuffer();

    if (buffer.byteLength > imageService.maxSizeBytes) {
      const maxMB = Math.round(imageService.maxSizeBytes / 1024 / 1024);
      return c.json({ error: `File too large. Maximum size: ${maxMB}MB` }, 400);
    }

    // Get current org to check for existing logo
    const orgRows = await query<Organization>(
      'SELECT branding_logo_id FROM organizations WHERE id = $1',
      [id]
    );

    if (!orgRows[0]) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    // Delete old logo if it exists
    const existingLogoId = orgRows[0].branding_logo_id;
    if (existingLogoId) {
      try {
        await imageService.delete(existingLogoId);
      } catch {
        logger.warn('Failed to delete old branding logo', { organizationId: id, existingLogoId });
      }
    }

    // Upload new logo
    const uploadResult = await imageService.upload(buffer, contentType, {
      imageType: 'branding-logo',
    });

    // Update organization
    await query(
      'UPDATE organizations SET branding_logo_id = $1, updated_at = NOW() WHERE id = $2',
      [uploadResult.id, id]
    );

    logger.info('Branding logo uploaded', {
      organizationId: id,
      brandingLogoId: uploadResult.id,
      userId: payload.userId,
    });

    // Emit socket event
    socketService.emitToOrganization(id, SocketEvents.ORGANIZATION_UPDATED, {
      organizationId: id,
      brandingLogoUrl: uploadResult.url,
      updatedBy: payload.userId,
      timestamp: new Date().toISOString(),
    });

    return c.json({
      brandingLogoUrl: uploadResult.url,
      brandingLogoId: uploadResult.id,
    });
  } catch (error: any) {
    logger.error('Upload branding logo error', { error, orgId: id });

    if (error.code === 'INVALID_TYPE' || error.code === 'FILE_TOO_LARGE') {
      return c.json({ error: error.message }, 400);
    }
    if (error.code === 'STORAGE_ERROR') {
      return c.json({ error: 'Failed to save image' }, 500);
    }
    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return c.json({ error: 'Failed to upload branding logo' }, 500);
  }
});

// Delete branding logo
const deleteBrandingLogoRoute = createRoute({
  method: 'delete',
  path: '/organizations/{id}/branding-logo',
  summary: 'Delete branding logo',
  tags: ['Organizations'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Branding logo deleted successfully',
      content: {
        'application/json': {
          schema: z.object({ success: z.boolean() }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    403: { description: 'Forbidden' },
    404: { description: 'No branding logo found' },
  },
});

app.openapi(deleteBrandingLogoRoute, async (c) => {
  const { id } = c.req.param();
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const { authService } = await import('../../services/auth');
    const payload = await authService.verifyToken(token);

    if (payload.organizationId !== id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (payload.role !== 'owner' && payload.role !== 'admin') {
      return c.json({ error: 'Only owners and admins can delete branding logo' }, 403);
    }

    const orgRows = await query<Organization>(
      'SELECT branding_logo_id FROM organizations WHERE id = $1',
      [id]
    );

    if (!orgRows[0]) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    if (!orgRows[0].branding_logo_id) {
      return c.json({ error: 'No branding logo to delete' }, 404);
    }

    // Delete file
    try {
      await imageService.delete(orgRows[0].branding_logo_id);
    } catch {
      logger.warn('Failed to delete branding logo file', {
        brandingLogoId: orgRows[0].branding_logo_id,
      });
    }

    // Clear from database
    await query(
      'UPDATE organizations SET branding_logo_id = NULL, updated_at = NOW() WHERE id = $1',
      [id]
    );

    logger.info('Branding logo deleted', {
      organizationId: id,
      deletedLogoId: orgRows[0].branding_logo_id,
      userId: payload.userId,
    });

    // Emit socket event
    socketService.emitToOrganization(id, SocketEvents.ORGANIZATION_UPDATED, {
      organizationId: id,
      brandingLogoUrl: null,
      updatedBy: payload.userId,
      timestamp: new Date().toISOString(),
    });

    return c.json({ success: true });
  } catch (error: any) {
    logger.error('Delete branding logo error', { error, orgId: id });

    if (error.message === 'Invalid token' || error.message === 'Token expired') {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return c.json({ error: 'Failed to delete branding logo' }, 500);
  }
});

export default app;