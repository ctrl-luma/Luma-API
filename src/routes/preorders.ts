import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from '../services/socket';
import { queueService, QueueName } from '../services/queue';

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

// ─── Response formatters ──────────────────────────────────────────────────────

function formatPreorder(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    catalogId: row.catalog_id,
    catalogName: row.catalog_name || null,
    orderNumber: row.order_number,
    dailyNumber: row.daily_number,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    paymentType: row.payment_type,
    subtotal: parseFloat(row.subtotal) || 0,
    taxAmount: parseFloat(row.tax_amount) || 0,
    tipAmount: parseFloat(row.tip_amount) || 0,
    totalAmount: parseFloat(row.total_amount) || 0,
    platformFeeCents: row.platform_fee_cents || 0,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeChargeId: row.stripe_charge_id,
    status: row.status,
    estimatedReadyAt: row.estimated_ready_at?.toISOString() || null,
    readyAt: row.ready_at?.toISOString() || null,
    pickedUpAt: row.picked_up_at?.toISOString() || null,
    pickedUpBy: row.picked_up_by,
    pickedUpByName: row.picked_up_by_name || null,
    orderNotes: row.order_notes,
    internalNotes: row.internal_notes,
    createdAt: row.created_at?.toISOString() || new Date().toISOString(),
    updatedAt: row.updated_at?.toISOString() || new Date().toISOString(),
  };
}

function formatPreorderItem(row: any) {
  return {
    id: row.id,
    catalogProductId: row.catalog_product_id,
    productId: row.product_id,
    name: row.name,
    unitPrice: parseFloat(row.unit_price),
    quantity: row.quantity,
    notes: row.notes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED ENDPOINTS (vendor management)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── List preorders ───────────────────────────────────────────────────────────

const listPreordersRoute = createRoute({
  method: 'get',
  path: '/preorders',
  summary: 'List preorders for organization',
  tags: ['Preorders'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'List of preorders' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listPreordersRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    logger.info('[PREORDER DEBUG] List preorders request', {
      userId: payload.userId,
      organizationId: payload.organizationId,
      role: payload.role,
    });

    const catalogId = c.req.query('catalogId');
    const status = c.req.query('status');
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = (page - 1) * limit;

    let whereClause = 'p.organization_id = $1';
    const params: any[] = [payload.organizationId];
    let paramCount = 2;

    if (catalogId) {
      whereClause += ` AND p.catalog_id = $${paramCount}`;
      params.push(catalogId);
      paramCount++;
    }

    if (status) {
      const statuses = status.split(',');
      whereClause += ` AND p.status = ANY($${paramCount})`;
      params.push(statuses);
      paramCount++;
    }

    // Count total
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) FROM preorders p WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0]?.count || '0');

    // Fetch preorders with catalog name
    const rows = await query(
      `SELECT p.*, c.name AS catalog_name
       FROM preorders p
       LEFT JOIN catalogs c ON p.catalog_id = c.id
       WHERE ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      [...params, limit, offset]
    );

    // Fetch items for all preorders in one query
    const preorderIds = rows.map(r => r.id);
    let itemsMap: Record<string, any[]> = {};

    if (preorderIds.length > 0) {
      const items = await query(
        `SELECT * FROM preorder_items WHERE preorder_id = ANY($1)`,
        [preorderIds]
      );

      // Group items by preorder_id
      itemsMap = items.reduce((acc: Record<string, any[]>, item: any) => {
        const pid = item.preorder_id;
        if (!acc[pid]) acc[pid] = [];
        acc[pid].push(formatPreorderItem(item));
        return acc;
      }, {});
    }

    logger.info('[PREORDER DEBUG] List preorders result', {
      organizationId: payload.organizationId,
      totalCount: total,
      returnedCount: rows.length,
      statusFilter: status || 'none',
      catalogIdFilter: catalogId || 'none',
      firstPreorderOrgId: rows[0]?.organization_id || 'N/A',
    });

    return c.json({
      preorders: rows.map(row => ({
        ...formatPreorder(row),
        items: itemsMap[row.id] || [],
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error listing preorders', { error });
    return c.json({ error: 'Failed to list preorders' }, 500);
  }
});

// ─── Get preorder stats ───────────────────────────────────────────────────────
// NOTE: This must be registered BEFORE /preorders/{id} to avoid route collision

const getPreorderStatsRoute = createRoute({
  method: 'get',
  path: '/preorders/stats',
  summary: 'Get preorder statistics for organization',
  tags: ['Preorders'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Preorder statistics' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(getPreorderStatsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    logger.info('[PREORDER DEBUG] Get preorder stats request', {
      userId: payload.userId,
      organizationId: payload.organizationId,
    });

    const catalogId = c.req.query('catalogId');

    let whereClause = 'organization_id = $1';
    const params: any[] = [payload.organizationId];

    if (catalogId) {
      whereClause += ' AND catalog_id = $2';
      params.push(catalogId);
    }

    const stats = await query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
        COUNT(*) FILTER (WHERE status = 'preparing') AS preparing_count,
        COUNT(*) FILTER (WHERE status = 'ready') AS ready_count,
        COUNT(*) FILTER (WHERE status = 'picked_up' AND DATE(picked_up_at) = CURRENT_DATE) AS completed_today,
        SUM(total_amount) FILTER (WHERE status = 'picked_up' AND DATE(picked_up_at) = CURRENT_DATE) AS revenue_today
       FROM preorders
       WHERE ${whereClause}`,
      params
    );

    const row = stats[0];
    const result = {
      pending: parseInt(row.pending_count) || 0,
      preparing: parseInt(row.preparing_count) || 0,
      ready: parseInt(row.ready_count) || 0,
      completedToday: parseInt(row.completed_today) || 0,
      revenueToday: parseFloat(row.revenue_today) || 0,
      activeOrders: (parseInt(row.pending_count) || 0) + (parseInt(row.preparing_count) || 0) + (parseInt(row.ready_count) || 0),
    };

    logger.info('[PREORDER DEBUG] Get preorder stats result', {
      organizationId: payload.organizationId,
      ...result,
    });

    return c.json(result);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error fetching preorder stats', { error });
    return c.json({ error: 'Failed to fetch preorder stats' }, 500);
  }
});

// ─── Get preorder details ─────────────────────────────────────────────────────

const getPreorderRoute = createRoute({
  method: 'get',
  path: '/preorders/{id}',
  summary: 'Get preorder details',
  tags: ['Preorders'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Preorder details' },
    401: { description: 'Unauthorized' },
    404: { description: 'Preorder not found' },
  },
});

app.openapi(getPreorderRoute, async (c) => {
  const { id } = c.req.param();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const rows = await query(
      `SELECT p.*, c.name AS catalog_name, c.location AS catalog_location,
        u.first_name || ' ' || u.last_name AS picked_up_by_name
       FROM preorders p
       LEFT JOIN catalogs c ON p.catalog_id = c.id
       LEFT JOIN users u ON p.picked_up_by = u.id
       WHERE p.id = $1 AND p.organization_id = $2`,
      [id, payload.organizationId]
    );

    if (!rows[0]) {
      return c.json({ error: 'Preorder not found' }, 404);
    }

    const preorder = rows[0];

    // Get items
    const items = await query(
      `SELECT * FROM preorder_items WHERE preorder_id = $1`,
      [id]
    );

    return c.json({
      preorder: {
        ...formatPreorder(preorder),
        catalogLocation: preorder.catalog_location,
        items: items.map(formatPreorderItem),
      },
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error fetching preorder', { error, id });
    return c.json({ error: 'Failed to fetch preorder' }, 500);
  }
});

// ─── Update preorder status ───────────────────────────────────────────────────

const updatePreorderStatusRoute = createRoute({
  method: 'patch',
  path: '/preorders/{id}/status',
  summary: 'Update preorder status',
  tags: ['Preorders'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['preparing', 'ready']),
            internalNotes: z.string().max(1000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Preorder status updated' },
    400: { description: 'Invalid status transition' },
    401: { description: 'Unauthorized' },
    404: { description: 'Preorder not found' },
  },
});

app.openapi(updatePreorderStatusRoute, async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Get current preorder
    const preorders = await query(
      `SELECT * FROM preorders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (!preorders[0]) {
      return c.json({ error: 'Preorder not found' }, 404);
    }

    const preorder = preorders[0];

    // Validate status transition
    const validTransitions: Record<string, string[]> = {
      pending: ['preparing', 'cancelled'],
      preparing: ['ready', 'cancelled'],
      ready: ['picked_up', 'cancelled'],
    };

    const currentStatus = preorder.status;
    if (!validTransitions[currentStatus]?.includes(body.status)) {
      return c.json({
        error: `Cannot transition from ${currentStatus} to ${body.status}`,
        code: 'INVALID_STATUS_TRANSITION',
        currentStatus,
        allowedStatuses: validTransitions[currentStatus] || [],
      }, 400);
    }

    // Build update
    const updates: string[] = ['status = $1', 'updated_at = NOW()'];
    const values: any[] = [body.status];
    let paramCount = 2;

    if (body.status === 'ready') {
      updates.push(`ready_at = NOW()`);
    }

    if (body.internalNotes !== undefined) {
      updates.push(`internal_notes = $${paramCount}`);
      values.push(body.internalNotes);
      paramCount++;
    }

    values.push(id, payload.organizationId);

    const result = await query(
      `UPDATE preorders SET ${updates.join(', ')}
       WHERE id = $${paramCount} AND organization_id = $${paramCount + 1}
       RETURNING *`,
      values
    );

    const updatedPreorder = result[0];

    logger.info('Preorder status updated', {
      preorderId: id,
      oldStatus: currentStatus,
      newStatus: body.status,
      updatedBy: payload.userId,
    });

    // Emit socket events
    socketService.emitToOrganization(payload.organizationId, SocketEvents.PREORDER_UPDATED, {
      preorderId: id,
      orderNumber: updatedPreorder.order_number,
      dailyNumber: updatedPreorder.daily_number,
      status: body.status,
      updatedBy: payload.userId,
    });

    // Emit to customer via public namespace
    socketService.emitToPreorder(id, SocketEvents.PREORDER_UPDATED, {
      preorderId: id,
      status: body.status,
    });

    // If status is 'ready', send notification email
    if (body.status === 'ready') {
      socketService.emitToPreorder(id, SocketEvents.PREORDER_READY, {
        preorderId: id,
        orderNumber: updatedPreorder.order_number,
        dailyNumber: updatedPreorder.daily_number,
      });

      // Get catalog for pickup instructions
      const catalogs = await query(
        `SELECT name, pickup_instructions FROM catalogs WHERE id = $1`,
        [updatedPreorder.catalog_id]
      );

      // Queue ready notification email
      await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
        type: 'preorder_ready',
        to: updatedPreorder.customer_email,
        data: {
          orderNumber: updatedPreorder.order_number,
          dailyNumber: updatedPreorder.daily_number,
          customerName: updatedPreorder.customer_name,
          catalogName: catalogs[0]?.name,
          pickupInstructions: catalogs[0]?.pickup_instructions,
        },
      });
    }

    return c.json({ preorder: formatPreorder(updatedPreorder) });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error updating preorder status', { error, id });
    return c.json({ error: 'Failed to update preorder status' }, 500);
  }
});

// ─── Complete preorder pickup ─────────────────────────────────────────────────

const completePreorderRoute = createRoute({
  method: 'post',
  path: '/preorders/{id}/complete',
  summary: 'Complete preorder pickup (processes payment for pay_at_pickup)',
  tags: ['Preorders'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            // For pay_at_pickup orders, link the payment
            stripePaymentIntentId: z.string().optional(),
            stripeChargeId: z.string().optional(),
            tipAmount: z.number().min(0).optional(), // Allow tip adjustment at pickup
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Preorder completed' },
    400: { description: 'Invalid request' },
    401: { description: 'Unauthorized' },
    404: { description: 'Preorder not found' },
  },
});

app.openapi(completePreorderRoute, async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const preorders = await query(
      `SELECT * FROM preorders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (!preorders[0]) {
      return c.json({ error: 'Preorder not found' }, 404);
    }

    const preorder = preorders[0];

    // Only allow completion from 'ready' status
    if (preorder.status !== 'ready') {
      return c.json({
        error: `Cannot complete preorder with status ${preorder.status}. Must be 'ready'.`,
        code: 'INVALID_STATUS',
        currentStatus: preorder.status,
      }, 400);
    }

    // For pay_at_pickup, require payment info
    if (preorder.payment_type === 'pay_at_pickup') {
      if (!body.stripePaymentIntentId) {
        return c.json({
          error: 'Payment required for pay_at_pickup orders',
          code: 'PAYMENT_REQUIRED',
        }, 400);
      }
    }

    // Calculate final amounts
    let finalTipAmount = parseFloat(preorder.tip_amount);
    let finalTotalAmount = parseFloat(preorder.total_amount);

    if (body.tipAmount !== undefined && body.tipAmount !== finalTipAmount) {
      const tipDiff = body.tipAmount - finalTipAmount;
      finalTipAmount = body.tipAmount;
      finalTotalAmount += tipDiff;
    }

    // Build update
    const updates: string[] = [
      'status = $1',
      'picked_up_at = NOW()',
      'picked_up_by = $2',
      'updated_at = NOW()',
    ];
    const values: any[] = ['picked_up', payload.userId];
    let paramCount = 3;

    if (body.stripePaymentIntentId) {
      updates.push(`stripe_payment_intent_id = $${paramCount}`);
      values.push(body.stripePaymentIntentId);
      paramCount++;
    }

    if (body.stripeChargeId) {
      updates.push(`stripe_charge_id = $${paramCount}`);
      values.push(body.stripeChargeId);
      paramCount++;
    }

    if (body.tipAmount !== undefined) {
      updates.push(`tip_amount = $${paramCount}`);
      values.push(finalTipAmount);
      paramCount++;
      updates.push(`total_amount = $${paramCount}`);
      values.push(finalTotalAmount);
      paramCount++;
    }

    values.push(id, payload.organizationId);

    const result = await query(
      `UPDATE preorders SET ${updates.join(', ')}
       WHERE id = $${paramCount} AND organization_id = $${paramCount + 1}
       RETURNING *`,
      values
    );

    const updatedPreorder = result[0];

    logger.info('Preorder completed', {
      preorderId: id,
      orderNumber: updatedPreorder.order_number,
      completedBy: payload.userId,
      paymentType: preorder.payment_type,
    });

    // Emit socket events
    socketService.emitToOrganization(payload.organizationId, SocketEvents.PREORDER_COMPLETED, {
      preorderId: id,
      orderNumber: updatedPreorder.order_number,
      dailyNumber: updatedPreorder.daily_number,
      totalAmount: finalTotalAmount,
      completedBy: payload.userId,
    });

    socketService.emitToPreorder(id, SocketEvents.PREORDER_COMPLETED, {
      preorderId: id,
      status: 'picked_up',
    });

    return c.json({ preorder: formatPreorder(updatedPreorder) });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error completing preorder', { error, id });
    return c.json({ error: 'Failed to complete preorder' }, 500);
  }
});

// ─── Cancel preorder (vendor) ─────────────────────────────────────────────────

const cancelPreorderVendorRoute = createRoute({
  method: 'post',
  path: '/preorders/{id}/cancel',
  summary: 'Cancel a preorder (with automatic refund for pay_now)',
  tags: ['Preorders'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            reason: z.string().max(500).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Preorder cancelled' },
    400: { description: 'Cannot cancel' },
    401: { description: 'Unauthorized' },
    404: { description: 'Preorder not found' },
  },
});

app.openapi(cancelPreorderVendorRoute, async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const preorders = await query(
      `SELECT * FROM preorders WHERE id = $1 AND organization_id = $2`,
      [id, payload.organizationId]
    );

    if (!preorders[0]) {
      return c.json({ error: 'Preorder not found' }, 404);
    }

    const preorder = preorders[0];

    // Cannot cancel already completed or cancelled orders
    if (preorder.status === 'picked_up' || preorder.status === 'cancelled') {
      return c.json({
        error: `Cannot cancel preorder with status ${preorder.status}`,
        code: 'CANNOT_CANCEL',
        currentStatus: preorder.status,
      }, 400);
    }

    // If paid, initiate refund
    let refunded = false;
    let refundAmount = 0;

    if (preorder.payment_type === 'pay_now' && preorder.stripe_charge_id) {
      const stripeAccounts = await query(
        `SELECT stripe_account_id FROM stripe_connected_accounts
         WHERE organization_id = $1 AND charges_enabled = true`,
        [payload.organizationId]
      );

      if (stripeAccounts[0]) {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

        await stripe.refunds.create(
          { charge: preorder.stripe_charge_id },
          { stripeAccount: stripeAccounts[0].stripe_account_id }
        );

        refunded = true;
        refundAmount = parseFloat(preorder.total_amount);

        logger.info('Preorder refund processed', {
          preorderId: id,
          chargeId: preorder.stripe_charge_id,
        });
      }
    }

    // Update status
    await query(
      `UPDATE preorders SET
        status = 'cancelled',
        internal_notes = COALESCE(internal_notes, '') || $1,
        updated_at = NOW()
       WHERE id = $2`,
      [body.reason ? `\nCancelled: ${body.reason}` : '\nCancelled by vendor', id]
    );

    logger.info('Preorder cancelled by vendor', {
      preorderId: id,
      cancelledBy: payload.userId,
      reason: body.reason,
    });

    // Emit socket events
    socketService.emitToOrganization(payload.organizationId, SocketEvents.PREORDER_CANCELLED, {
      preorderId: id,
      orderNumber: preorder.order_number,
      dailyNumber: preorder.daily_number,
      cancelledBy: payload.userId,
    });

    socketService.emitToPreorder(id, SocketEvents.PREORDER_CANCELLED, {
      preorderId: id,
      status: 'cancelled',
    });

    // Get catalog name for the email
    const catalogs = await query(
      `SELECT name FROM catalogs WHERE id = $1`,
      [preorder.catalog_id]
    );

    // Queue cancellation email to customer
    await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
      type: 'preorder_cancelled',
      to: preorder.customer_email,
      data: {
        orderNumber: preorder.order_number,
        dailyNumber: preorder.daily_number,
        customerName: preorder.customer_name,
        catalogName: catalogs[0]?.name || 'Your order',
        cancellationReason: body.reason || 'Order cancelled by vendor',
        paymentType: preorder.payment_type,
        refundIssued: refunded,
        totalAmount: parseFloat(preorder.total_amount),
      },
    });

    return c.json({ success: true, message: 'Preorder cancelled', refunded, refundAmount });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error cancelling preorder', { error, id });
    return c.json({ error: 'Failed to cancel preorder' }, 500);
  }
});

export default app;
