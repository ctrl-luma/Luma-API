import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { logger } from '../utils/logger';

const app = new OpenAPIHono();

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function verifyAuth(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = authHeader.substring(7);
  const { authService } = await import('../services/auth');
  return authService.verifyToken(token);
}

function formatDispute(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    stripeDisputeId: row.stripe_dispute_id,
    stripeChargeId: row.stripe_charge_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    amount: row.amount,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    customerEmail: row.customer_email,
    customerName: row.customer_name,
    orderId: row.order_id,
    preorderId: row.preorder_id,
    invoiceId: row.invoice_id,
    ticketId: row.ticket_id,
    isChargeRefundable: row.is_charge_refundable,
    fundsWithdrawn: row.funds_withdrawn,
    fundsReinstated: row.funds_reinstated,
    stripeDashboardUrl: row.stripe_dashboard_url,
    evidenceDueBy: row.evidence_due_by?.toISOString() || null,
    createdAt: row.created_at?.toISOString() || new Date().toISOString(),
    updatedAt: row.updated_at?.toISOString() || new Date().toISOString(),
    closedAt: row.closed_at?.toISOString() || null,
  };
}

// ─── GET /disputes — List disputes ──────────────────────────────────────────────

const listDisputesRoute = createRoute({
  method: 'get',
  path: '/disputes',
  summary: 'List disputes',
  tags: ['Disputes'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.string().optional(),
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: { description: 'List of disputes' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listDisputesRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = (page - 1) * limit;

    let whereClause = 'd.organization_id = $1';
    const params: any[] = [payload.organizationId];
    let paramCount = 2;

    const status = c.req.query('status');
    if (status) {
      const statuses = status.split(',').map(s => s.trim());
      const placeholders = statuses.map((_, idx) => `$${paramCount + idx}`);
      whereClause += ` AND d.status IN (${placeholders.join(',')})`;
      params.push(...statuses);
      paramCount += statuses.length;
    }

    // Count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM disputes d WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0]?.count || '0');

    // Fetch disputes
    params.push(limit, offset);
    const disputes = await query<any>(
      `SELECT d.*
       FROM disputes d
       WHERE ${whereClause}
       ORDER BY d.created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      params
    );

    return c.json({
      disputes: disputes.map(formatDispute),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing disputes', { error });
    return c.json({ error: 'Failed to list disputes' }, 500);
  }
});

// ─── GET /disputes/stats — Aggregate stats ──────────────────────────────────────

const disputeStatsRoute = createRoute({
  method: 'get',
  path: '/disputes/stats',
  summary: 'Get dispute statistics',
  tags: ['Disputes'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Dispute statistics' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(disputeStatsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const result = await query<any>(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status IN ('needs_response', 'warning_needs_response')) AS needs_response,
        COUNT(*) FILTER (WHERE status IN ('under_review', 'warning_under_review')) AS under_review,
        COUNT(*) FILTER (WHERE status = 'won' OR status = 'warning_closed') AS won,
        COUNT(*) FILTER (WHERE status = 'lost') AS lost,
        COALESCE(SUM(amount), 0) AS total_amount_cents,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('needs_response', 'warning_needs_response', 'under_review', 'warning_under_review')), 0) AS open_amount_cents
      FROM disputes WHERE organization_id = $1`,
      [payload.organizationId]
    );

    const stats = result[0];
    return c.json({
      total: parseInt(stats.total),
      needsResponse: parseInt(stats.needs_response),
      underReview: parseInt(stats.under_review),
      won: parseInt(stats.won),
      lost: parseInt(stats.lost),
      totalAmountCents: parseInt(stats.total_amount_cents),
      openAmountCents: parseInt(stats.open_amount_cents),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error getting dispute stats', { error });
    return c.json({ error: 'Failed to get dispute stats' }, 500);
  }
});

export default app;
