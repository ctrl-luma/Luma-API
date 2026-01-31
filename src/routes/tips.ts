import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { tipsService } from '../services/tips';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';

const app = new OpenAPIHono();

// Schema definitions
const tipReportSummarySchema = z.object({
  totalTips: z.number(),
  orderCount: z.number(),
  avgTipAmount: z.number(),
  avgTipPercent: z.number(),
});

const staffTipReportSchema = z.object({
  userId: z.string().uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  tipCount: z.number(),
  totalTips: z.number(),
  avgTip: z.number(),
});

const dailyStaffTipSchema = z.object({
  userId: z.string().uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  totalTips: z.number(),
});

const dailyTipReportSchema = z.object({
  date: z.string(),
  totalTips: z.number(),
  orderCount: z.number(),
  byStaff: z.array(dailyStaffTipSchema),
});

const tipDistributionBucketSchema = z.object({
  range: z.string(),
  count: z.number(),
});

const hourlyTipBreakdownSchema = z.object({
  hour: z.number(),
  totalTips: z.number(),
  tipCount: z.number(),
  avgTip: z.number(),
});

const tipTrendPointSchema = z.object({
  date: z.string(),
  tipPercent: z.number(),
});

const topTippedOrderSchema = z.object({
  orderNumber: z.string(),
  tipAmount: z.number(),
  subtotal: z.number(),
  totalAmount: z.number(),
  customerEmail: z.string().nullable(),
  createdAt: z.string(),
});

const tipReportSchema = z.object({
  summary: tipReportSummarySchema,
  byStaff: z.array(staffTipReportSchema),
  daily: z.array(dailyTipReportSchema),
  tipDistribution: z.array(tipDistributionBucketSchema),
  hourlyBreakdown: z.array(hourlyTipBreakdownSchema),
  tipTrend: z.array(tipTrendPointSchema),
  topTippedOrders: z.array(topTippedOrderSchema),
});

const tipPoolMemberSchema = z.object({
  id: z.string().uuid(),
  tipPoolId: z.string().uuid(),
  userId: z.string().uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  hoursWorked: z.number(),
  tipsEarned: z.number(),
  poolShare: z.number(),
  finalAmount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const tipPoolSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  totalTips: z.number(),
  status: z.enum(['draft', 'calculated', 'finalized']),
  notes: z.string().nullable(),
  createdBy: z.string().uuid(),
  creatorFirstName: z.string().nullable(),
  creatorLastName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const tipPoolDetailSchema = tipPoolSchema.extend({
  members: z.array(tipPoolMemberSchema),
});

const createTipPoolSchema = z.object({
  name: z.string().min(1).max(255),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  notes: z.string().max(1000).optional(),
});

const updateTipPoolSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  notes: z.string().max(1000).optional(),
}).refine(data => data.name || data.notes !== undefined, {
  message: 'At least one field must be provided',
});

const setPoolMembersSchema = z.object({
  members: z.array(z.object({
    userId: z.string().uuid(),
    hoursWorked: z.number().min(0),
  })),
});

const staffWithTipsSchema = z.object({
  userId: z.string().uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  totalTips: z.number(),
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

// Helper to transform DB row to API response format
function transformPool(pool: any) {
  return {
    id: pool.id,
    organizationId: pool.organization_id,
    name: pool.name,
    startDate: pool.start_date instanceof Date
      ? pool.start_date.toISOString().split('T')[0]
      : pool.start_date,
    endDate: pool.end_date instanceof Date
      ? pool.end_date.toISOString().split('T')[0]
      : pool.end_date,
    totalTips: pool.total_tips,
    status: pool.status,
    notes: pool.notes,
    createdBy: pool.created_by,
    creatorFirstName: pool.creator_first_name || null,
    creatorLastName: pool.creator_last_name || null,
    createdAt: pool.created_at instanceof Date
      ? pool.created_at.toISOString()
      : pool.created_at,
    updatedAt: pool.updated_at instanceof Date
      ? pool.updated_at.toISOString()
      : pool.updated_at,
  };
}

function transformMember(member: any) {
  return {
    id: member.id,
    tipPoolId: member.tip_pool_id,
    userId: member.user_id,
    firstName: member.first_name || null,
    lastName: member.last_name || null,
    avatarUrl: member.avatarUrl || null,
    hoursWorked: parseFloat(member.hours_worked) || 0,
    tipsEarned: member.tips_earned,
    poolShare: member.pool_share,
    finalAmount: member.final_amount,
    createdAt: member.created_at instanceof Date
      ? member.created_at.toISOString()
      : member.created_at,
    updatedAt: member.updated_at instanceof Date
      ? member.updated_at.toISOString()
      : member.updated_at,
  };
}

// ==================== TIP REPORTS ====================

// GET /tips/report
const getTipReportRoute = createRoute({
  method: 'get',
  path: '/tips/report',
  summary: 'Get tip report for a date range',
  description: 'Returns tip analytics including summary, breakdown by staff, and daily totals.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
    }),
  },
  responses: {
    200: {
      description: 'Tip report data',
      content: {
        'application/json': {
          schema: tipReportSchema,
        },
      },
    },
    400: { description: 'Invalid date format' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(getTipReportRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { startDate, endDate } = c.req.query();

    const report = await tipsService.getTipReport(
      payload.organizationId,
      startDate,
      endDate
    );

    return c.json(report, 200);
  } catch (error: any) {
    logger.error('Failed to get tip report', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: error.message || 'Failed to get tip report' }, 400);
  }
});

// GET /tips/staff - Get staff who had tips in a date range
const getStaffWithTipsRoute = createRoute({
  method: 'get',
  path: '/tips/staff',
  summary: 'Get staff members who earned tips in a date range',
  description: 'Returns list of staff who had tips, useful for populating tip pool members.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
    }),
  },
  responses: {
    200: {
      description: 'Staff with tips',
      content: {
        'application/json': {
          schema: z.array(staffWithTipsSchema),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(getStaffWithTipsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { startDate, endDate } = c.req.query();

    const staff = await tipsService.getStaffWithTips(
      payload.organizationId,
      startDate,
      endDate
    );

    return c.json(staff, 200);
  } catch (error: any) {
    logger.error('Failed to get staff with tips', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: error.message }, 400);
  }
});

// ==================== TIP POOLS ====================

// GET /tips/pools
const listPoolsRoute = createRoute({
  method: 'get',
  path: '/tips/pools',
  summary: 'List tip pools',
  description: 'Returns list of tip pools for the organization.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.enum(['draft', 'calculated', 'finalized']).optional(),
      limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 20),
      offset: z.string().optional().transform(v => v ? parseInt(v, 10) : 0),
    }),
  },
  responses: {
    200: {
      description: 'List of tip pools',
      content: {
        'application/json': {
          schema: z.object({
            pools: z.array(tipPoolSchema),
            total: z.number(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listPoolsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { status, limit, offset } = c.req.query();

    const result = await tipsService.listPools(payload.organizationId, {
      status: status as any,
      limit: typeof limit === 'number' ? limit : 20,
      offset: typeof offset === 'number' ? offset : 0,
    });

    return c.json({
      pools: result.pools.map(transformPool),
      total: result.total,
    }, 200);
  } catch (error: any) {
    logger.error('Failed to list tip pools', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: error.message }, 400);
  }
});

// POST /tips/pools
const createPoolRoute = createRoute({
  method: 'post',
  path: '/tips/pools',
  summary: 'Create a tip pool',
  description: 'Creates a new tip pool for the specified date range.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: createTipPoolSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Tip pool created',
      content: {
        'application/json': {
          schema: tipPoolSchema,
        },
      },
    },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(createPoolRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = await c.req.json();

    const pool = await tipsService.createPool({
      organizationId: payload.organizationId,
      name: body.name,
      startDate: body.startDate,
      endDate: body.endDate,
      notes: body.notes,
      createdBy: payload.userId,
    });

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.TIP_UPDATED, {
      poolId: pool.id,
      action: 'created',
    });

    return c.json(transformPool({
      ...pool,
      creator_first_name: null,
      creator_last_name: null,
    }), 201);
  } catch (error: any) {
    logger.error('Failed to create tip pool', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: error.message || 'Failed to create tip pool' }, 400);
  }
});

// GET /tips/pools/:id
const getPoolRoute = createRoute({
  method: 'get',
  path: '/tips/pools/:id',
  summary: 'Get tip pool details',
  description: 'Returns tip pool with all members and their calculated shares.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Tip pool details',
      content: {
        'application/json': {
          schema: tipPoolDetailSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'Tip pool not found' },
  },
});

app.openapi(getPoolRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { id } = c.req.param();

    const pool = await tipsService.getPool(id, payload.organizationId);

    if (!pool) {
      return c.json({ error: 'Tip pool not found' }, 404);
    }

    return c.json({
      ...transformPool(pool),
      members: pool.members.map(transformMember),
    }, 200);
  } catch (error: any) {
    logger.error('Failed to get tip pool', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: error.message }, 400);
  }
});

// PATCH /tips/pools/:id
const updatePoolRoute = createRoute({
  method: 'patch',
  path: '/tips/pools/:id',
  summary: 'Update a tip pool',
  description: 'Updates tip pool name or notes.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateTipPoolSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Tip pool updated',
      content: {
        'application/json': {
          schema: tipPoolSchema,
        },
      },
    },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthorized' },
    404: { description: 'Tip pool not found' },
  },
});

app.openapi(updatePoolRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { id } = c.req.param();
    const body = await c.req.json();

    const pool = await tipsService.updatePool(id, payload.organizationId, body);

    if (!pool) {
      return c.json({ error: 'Tip pool not found' }, 404);
    }

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.TIP_UPDATED, {
      poolId: id,
      action: 'updated',
    });

    return c.json(transformPool({
      ...pool,
      creator_first_name: null,
      creator_last_name: null,
    }), 200);
  } catch (error: any) {
    logger.error('Failed to update tip pool', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: error.message || 'Failed to update tip pool' }, 400);
  }
});

// DELETE /tips/pools/:id
const deletePoolRoute = createRoute({
  method: 'delete',
  path: '/tips/pools/:id',
  summary: 'Delete a tip pool',
  description: 'Deletes a tip pool. Only works for pools in draft status.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    204: { description: 'Tip pool deleted' },
    400: { description: 'Cannot delete - pool is not in draft status' },
    401: { description: 'Unauthorized' },
    404: { description: 'Tip pool not found' },
  },
});

app.openapi(deletePoolRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { id } = c.req.param();

    const deleted = await tipsService.deletePool(id, payload.organizationId);

    if (!deleted) {
      return c.json({ error: 'Tip pool not found or not in draft status' }, 404);
    }

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.TIP_UPDATED, {
      poolId: id,
      action: 'deleted',
    });

    return c.body(null, 204);
  } catch (error: any) {
    logger.error('Failed to delete tip pool', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: error.message }, 400);
  }
});

// ==================== TIP POOL MEMBERS ====================

// POST /tips/pools/:id/members
const setPoolMembersRoute = createRoute({
  method: 'post',
  path: '/tips/pools/:id/members',
  summary: 'Add or update pool members',
  description: 'Sets the members for a tip pool with their hours worked.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: setPoolMembersSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Members updated',
      content: {
        'application/json': {
          schema: z.array(tipPoolMemberSchema),
        },
      },
    },
    400: { description: 'Invalid request or pool is finalized' },
    401: { description: 'Unauthorized' },
    404: { description: 'Tip pool not found' },
  },
});

app.openapi(setPoolMembersRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { id } = c.req.param();
    const body = await c.req.json();

    const members = await tipsService.setPoolMembers(
      id,
      payload.organizationId,
      body.members
    );

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.TIP_UPDATED, {
      poolId: id,
      action: 'members_updated',
    });

    return c.json(members.map(transformMember), 200);
  } catch (error: any) {
    logger.error('Failed to set pool members', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Tip pool not found') {
      return c.json({ error: error.message }, 404);
    }
    return c.json({ error: error.message || 'Failed to set pool members' }, 400);
  }
});

// DELETE /tips/pools/:id/members/:userId
const removePoolMemberRoute = createRoute({
  method: 'delete',
  path: '/tips/pools/:id/members/:userId',
  summary: 'Remove a member from the pool',
  description: 'Removes a staff member from the tip pool.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
    }),
  },
  responses: {
    204: { description: 'Member removed' },
    400: { description: 'Pool is finalized or member not found' },
    401: { description: 'Unauthorized' },
    404: { description: 'Tip pool not found' },
  },
});

app.openapi(removePoolMemberRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { id, userId } = c.req.param();

    const removed = await tipsService.removePoolMember(id, userId, payload.organizationId);

    if (!removed) {
      return c.json({ error: 'Member not found in pool' }, 404);
    }

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.TIP_UPDATED, {
      poolId: id,
      action: 'member_removed',
    });

    return c.body(null, 204);
  } catch (error: any) {
    logger.error('Failed to remove pool member', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Tip pool not found') {
      return c.json({ error: error.message }, 404);
    }
    return c.json({ error: error.message }, 400);
  }
});

// ==================== TIP POOL ACTIONS ====================

// POST /tips/pools/:id/calculate
const calculatePoolRoute = createRoute({
  method: 'post',
  path: '/tips/pools/:id/calculate',
  summary: 'Calculate tip distribution',
  description: 'Calculates each member\'s share based on hours worked.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Pool calculated',
      content: {
        'application/json': {
          schema: tipPoolDetailSchema,
        },
      },
    },
    400: { description: 'Cannot calculate - pool is finalized or has no members' },
    401: { description: 'Unauthorized' },
    404: { description: 'Tip pool not found' },
  },
});

app.openapi(calculatePoolRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { id } = c.req.param();

    const pool = await tipsService.calculatePool(id, payload.organizationId);

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.TIP_UPDATED, {
      poolId: id,
      action: 'calculated',
    });

    return c.json({
      ...transformPool(pool),
      members: pool.members.map(transformMember),
    }, 200);
  } catch (error: any) {
    logger.error('Failed to calculate tip pool', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Tip pool not found') {
      return c.json({ error: error.message }, 404);
    }
    return c.json({ error: error.message || 'Failed to calculate tip pool' }, 400);
  }
});

// POST /tips/pools/:id/finalize
const finalizePoolRoute = createRoute({
  method: 'post',
  path: '/tips/pools/:id/finalize',
  summary: 'Finalize tip pool',
  description: 'Locks the tip pool from further modifications.',
  tags: ['Tips'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Pool finalized',
      content: {
        'application/json': {
          schema: tipPoolSchema,
        },
      },
    },
    400: { description: 'Cannot finalize - pool must be calculated first' },
    401: { description: 'Unauthorized' },
    404: { description: 'Tip pool not found' },
  },
});

app.openapi(finalizePoolRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const { id } = c.req.param();

    const pool = await tipsService.finalizePool(id, payload.organizationId);

    // Emit socket event for real-time updates
    socketService.emitToOrganization(payload.organizationId, SocketEvents.TIP_UPDATED, {
      poolId: id,
      action: 'finalized',
    });

    return c.json(transformPool({
      ...pool,
      creator_first_name: null,
      creator_last_name: null,
    }), 200);
  } catch (error: any) {
    logger.error('Failed to finalize tip pool', error);
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.message === 'Tip pool not found') {
      return c.json({ error: error.message }, 404);
    }
    return c.json({ error: error.message || 'Failed to finalize tip pool' }, 400);
  }
});

export default app;
