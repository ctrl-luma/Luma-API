import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { logger } from '../utils/logger';
import { cacheService, CacheKeys } from '../services/redis/cache';
import { config } from '../config';
import { rateLimit } from '../middleware/rate-limit';

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      logger.error('[Referrals OpenAPI Validation Error]', {
        path: c.req.path,
        method: c.req.method,
        errors: result.error.issues,
        errorFlat: result.error.flatten(),
      });
      return c.json(
        {
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: result.error.issues,
        },
        400
      );
    }
    return undefined;
  },
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function verifyAuth(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = authHeader.substring(7);
  const { authService } = await import('../services/auth');
  return authService.verifyToken(token);
}

function generateReferralCode(firstName: string): string {
  const name = firstName.toUpperCase().replace(/[^A-Z]/g, '').substring(0, 6);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0/O, 1/I/L)
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${name}-${suffix}`;
}

function getSiteUrl(): string {
  return config.email.siteUrl || 'https://lumapos.co';
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /referrals/code — Get or generate referral code
// ═══════════════════════════════════════════════════════════════════════════════

const getReferralCodeRoute = createRoute({
  method: 'get',
  path: '/referrals/code',
  summary: 'Get or generate referral code',
  tags: ['Referrals'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Referral code' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(getReferralCodeRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Check if user already has a referral code
    const userResult = await query<{ referral_code: string | null; first_name: string }>(
      `SELECT referral_code, first_name FROM users WHERE id = $1`,
      [payload.userId]
    );

    if (userResult.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    let code = userResult[0].referral_code;

    if (!code) {
      // Generate a new code and save it
      const firstName = userResult[0].first_name || 'USER';
      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        code = generateReferralCode(firstName);
        try {
          await query(
            `UPDATE users SET referral_code = $1 WHERE id = $2`,
            [code, payload.userId]
          );
          // Invalidate user cache
          await cacheService.del(CacheKeys.user(payload.userId));
          await cacheService.del(CacheKeys.userByEmail(payload.email));
          break;
        } catch (err: any) {
          // Unique constraint violation — try again
          if (err.code === '23505') {
            attempts++;
            if (attempts >= maxAttempts) {
              logger.error('[Referrals] Failed to generate unique referral code after max attempts', {
                userId: payload.userId,
              });
              return c.json({ error: 'Failed to generate referral code. Please try again.' }, 500);
            }
          } else {
            throw err;
          }
        }
      }
    }

    const siteUrl = getSiteUrl();
    return c.json({
      code,
      url: `${siteUrl}/r/${code}`,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('[Referrals] Failed to get referral code', { error });
    return c.json({ error: 'Failed to get referral code' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /referrals/code/customize — Customize referral code
// ═══════════════════════════════════════════════════════════════════════════════

const CustomizeCodeSchema = z.object({
  code: z.string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9-]+$/, 'Code must contain only letters, numbers, and hyphens'),
});

const customizeCodeRoute = createRoute({
  method: 'post',
  path: '/referrals/code/customize',
  summary: 'Customize referral code',
  tags: ['Referrals'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: CustomizeCodeSchema,
        },
      },
    },
  },
  responses: {
    200: { description: 'Updated referral code' },
    400: { description: 'Invalid or taken code' },
    401: { description: 'Unauthorized' },
    409: { description: 'Code already taken' },
  },
});

app.openapi(customizeCodeRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));
    const body = c.req.valid('json');

    const newCode = body.code.trim();

    // Check if code is already taken by another user
    const existingResult = await query<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(referral_code) = LOWER($1) AND id != $2`,
      [newCode, payload.userId]
    );

    if (existingResult.length > 0) {
      return c.json({ error: 'This referral code is already taken' }, 409);
    }

    // Update the user's referral code
    await query(
      `UPDATE users SET referral_code = $1 WHERE id = $2`,
      [newCode, payload.userId]
    );

    // Invalidate user cache
    await cacheService.del(CacheKeys.user(payload.userId));
    await cacheService.del(CacheKeys.userByEmail(payload.email));

    const siteUrl = getSiteUrl();
    return c.json({
      code: newCode,
      url: `${siteUrl}/r/${newCode}`,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.code === '23505') {
      return c.json({ error: 'This referral code is already taken' }, 409);
    }
    logger.error('[Referrals] Failed to customize referral code', { error });
    return c.json({ error: 'Failed to customize referral code' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /referrals/validate — Validate a referral code (PUBLIC)
// ═══════════════════════════════════════════════════════════════════════════════

const ValidateCodeSchema = z.object({
  code: z.string().min(1),
});

const validateCodeRoute = createRoute({
  method: 'post',
  path: '/referrals/validate',
  summary: 'Validate a referral code (public)',
  tags: ['Referrals'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ValidateCodeSchema,
        },
      },
    },
  },
  responses: {
    200: { description: 'Validation result' },
  },
});

// Rate limit: 20 attempts per 15 minutes to prevent code enumeration
app.use('/referrals/validate', rateLimit({ max: 20, windowSeconds: 15 * 60, keyPrefix: 'validate-referral' }));

app.openapi(validateCodeRoute, async (c) => {
  try {
    const body = c.req.valid('json');
    const code = body.code.trim();

    const result = await query<{ first_name: string }>(
      `SELECT first_name FROM users
       WHERE LOWER(referral_code) = LOWER($1) AND is_active = true`,
      [code]
    );

    if (result.length === 0) {
      return c.json({ valid: false });
    }

    return c.json({
      valid: true,
      referrerFirstName: result[0].first_name,
    });
  } catch (error: any) {
    logger.error('[Referrals] Failed to validate referral code', { error });
    return c.json({ valid: false });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /referrals — List referrals for current user
// ═══════════════════════════════════════════════════════════════════════════════

const listReferralsRoute = createRoute({
  method: 'get',
  path: '/referrals',
  summary: 'List referrals',
  tags: ['Referrals'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'List of referrals' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listReferralsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const status = c.req.query('status');
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0'));

    let whereClause = 'WHERE r.referrer_user_id = $1';
    const params: any[] = [payload.userId];

    if (status) {
      params.push(status);
      whereClause += ` AND r.status = $${params.length}`;
    }

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM referrals r ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0]?.count || '0');

    // Get referrals with referred user info and total earned
    params.push(limit, offset);
    const referrals = await query(
      `SELECT r.id, r.referral_code, r.status, r.activated_at, r.created_at,
              u.first_name AS referred_first_name, u.email AS referred_email,
              COALESCE((SELECT SUM(re.earning_amount) FROM referral_earnings re WHERE re.referral_id = r.id AND re.status IN ('available', 'paid')), 0) AS total_earned
       FROM referrals r
       JOIN users u ON r.referred_user_id = u.id
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return c.json({
      referrals: referrals.map((r: any) => ({
        id: r.id,
        referralCode: r.referral_code,
        status: r.status,
        referredName: r.referred_first_name || 'Unknown',
        referredEmail: r.referred_email,
        totalEarned: parseFloat(r.total_earned || '0'),
        activatedAt: r.activated_at?.toISOString() || null,
        createdAt: r.created_at?.toISOString() || new Date().toISOString(),
      })),
      total,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('[Referrals] Failed to list referrals', { error });
    return c.json({ error: 'Failed to list referrals' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /referrals/stats — Referral stats for current user
// ═══════════════════════════════════════════════════════════════════════════════

const referralStatsRoute = createRoute({
  method: 'get',
  path: '/referrals/stats',
  summary: 'Get referral stats',
  tags: ['Referrals'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Referral statistics' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(referralStatsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    // Earnings stats
    const earningsResult = await query<{
      total_earned: string | null;
      pending_earnings: string | null;
      available_balance: string | null;
      total_paid: string | null;
      total_clawed_back: string | null;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('available', 'paid') THEN earning_amount ELSE 0 END), 0) AS total_earned,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN earning_amount ELSE 0 END), 0) AS pending_earnings,
         COALESCE(SUM(CASE WHEN status = 'available' THEN earning_amount ELSE 0 END), 0) AS available_balance,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN earning_amount ELSE 0 END), 0) AS total_paid,
         COALESCE(SUM(CASE WHEN status = 'clawed_back' THEN earning_amount ELSE 0 END), 0) AS total_clawed_back
       FROM referral_earnings
       WHERE referrer_user_id = $1`,
      [payload.userId]
    );

    // Referral counts
    const referralCounts = await query<{
      active_referrals: string;
      pending_referrals: string;
      total_referrals: string;
    }>(
      `SELECT
         COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_referrals,
         COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_referrals,
         COUNT(*) AS total_referrals
       FROM referrals
       WHERE referrer_user_id = $1`,
      [payload.userId]
    );

    const earnings = earningsResult[0];
    const counts = referralCounts[0];

    return c.json({
      totalEarned: parseFloat(earnings?.total_earned || '0'),
      pendingEarnings: parseFloat(earnings?.pending_earnings || '0'),
      availableBalance: parseFloat(earnings?.available_balance || '0'),
      totalPaid: parseFloat(earnings?.total_paid || '0'),
      totalClawedBack: parseFloat(earnings?.total_clawed_back || '0'),
      activeReferrals: parseInt(counts?.active_referrals || '0'),
      pendingReferrals: parseInt(counts?.pending_referrals || '0'),
      totalReferrals: parseInt(counts?.total_referrals || '0'),
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('[Referrals] Failed to get referral stats', { error });
    return c.json({ error: 'Failed to get referral stats' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /referrals/earnings — List referral earnings
// ═══════════════════════════════════════════════════════════════════════════════

const listEarningsRoute = createRoute({
  method: 'get',
  path: '/referrals/earnings',
  summary: 'List referral earnings',
  tags: ['Referrals'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'List of earnings' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listEarningsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0'));

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM referral_earnings WHERE referrer_user_id = $1`,
      [payload.userId]
    );
    const total = parseInt(countResult[0]?.count || '0');

    const earnings = await query(
      `SELECT id, source_type, gross_amount, earning_amount, currency, status, available_at, paid_at, clawed_back_at, clawed_back_reason, created_at
       FROM referral_earnings
       WHERE referrer_user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [payload.userId, limit, offset]
    );

    return c.json({
      earnings: earnings.map((e: any) => ({
        id: e.id,
        sourceType: e.source_type,
        grossAmount: parseFloat(e.gross_amount),
        earningAmount: parseFloat(e.earning_amount),
        currency: e.currency,
        status: e.status,
        availableAt: e.available_at?.toISOString() || null,
        paidAt: e.paid_at?.toISOString() || null,
        clawedBackAt: e.clawed_back_at?.toISOString() || null,
        clawedBackReason: e.clawed_back_reason || null,
        createdAt: e.created_at?.toISOString() || new Date().toISOString(),
      })),
      total,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('[Referrals] Failed to list earnings', { error });
    return c.json({ error: 'Failed to list earnings' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /referrals/payouts — List referral payouts
// ═══════════════════════════════════════════════════════════════════════════════

const listPayoutsRoute = createRoute({
  method: 'get',
  path: '/referrals/payouts',
  summary: 'List referral payouts',
  tags: ['Referrals'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'List of payouts' },
    401: { description: 'Unauthorized' },
  },
});

app.openapi(listPayoutsRoute, async (c) => {
  try {
    const payload = await verifyAuth(c.req.header('Authorization'));

    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0'));

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM referral_payouts WHERE user_id = $1`,
      [payload.userId]
    );
    const total = parseInt(countResult[0]?.count || '0');

    const payouts = await query(
      `SELECT id, amount, currency, stripe_transfer_id, status, failed_reason, completed_at, created_at
       FROM referral_payouts
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [payload.userId, limit, offset]
    );

    return c.json({
      payouts: payouts.map((p: any) => ({
        id: p.id,
        amount: parseFloat(p.amount),
        currency: p.currency,
        stripeTransferId: p.stripe_transfer_id,
        status: p.status,
        failedReason: p.failed_reason,
        completedAt: p.completed_at?.toISOString() || null,
        createdAt: p.created_at?.toISOString() || new Date().toISOString(),
      })),
      total,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('[Referrals] Failed to list payouts', { error });
    return c.json({ error: 'Failed to list payouts' }, 500);
  }
});

export default app;
