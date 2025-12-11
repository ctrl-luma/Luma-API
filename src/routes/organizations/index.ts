import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../../db';
import { Organization } from '../../db/models';
import { logger } from '../../utils/logger';

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

// Update organization
const updateOrganizationRoute = createRoute({
  method: 'put',
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
      updates.push(`settings = $${paramCount}`);
      values.push(body.settings);
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

    return c.json({
      id: org.id,
      name: org.name,
      stripeAccountId: org.stripe_account_id,
      stripeOnboardingCompleted: org.stripe_onboarding_completed,
      settings: org.settings,
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

export default app;