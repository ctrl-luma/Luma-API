import { query } from '../db';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from './socket';

/**
 * Record a referral earning when a referred user generates revenue (ticket sale or subscription).
 * If the referral is still 'pending', this activates it.
 * Earnings start in 'pending' status with a 30-day hold before becoming 'available'.
 *
 * @param client - Transaction client (must be called within a transaction)
 * @param referredUserId - The user who was referred (org owner generating the revenue)
 * @param sourceType - 'subscription' or 'ticket_sale'
 * @param sourceId - Payment intent ID or invoice ID for lookup/clawback
 * @param grossAmount - Luma's platform fee revenue in base currency unit (dollars for USD)
 * @param currency - 3-letter currency code
 */
export async function recordReferralEarning(client: any, referredUserId: string, sourceType: string, sourceId: string, grossAmount: number, currency: string) {
  // Check if this user was referred
  const referralResult = await client.query(
    `SELECT r.id, r.referrer_user_id, r.status, r.activated_at
     FROM referrals r
     WHERE r.referred_user_id = $1 AND r.status IN ('pending', 'active')
       AND CASE
         WHEN r.activated_at IS NOT NULL THEN r.activated_at > NOW() - INTERVAL '12 months'
         ELSE r.created_at > NOW() - INTERVAL '12 months'
       END`,
    [referredUserId]
  );

  if (referralResult.rows.length === 0) return;

  const referral = referralResult.rows[0];
  const earningAmount = parseFloat((grossAmount * 0.15).toFixed(2)); // 15% of Luma's revenue

  if (earningAmount <= 0) return;

  // If referral is still pending, activate it now
  if (referral.status === 'pending') {
    await client.query(
      `UPDATE referrals SET status = 'active', activated_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [referral.id]
    );

    // Notify referrer about activation
    socketService.emitToUser(referral.referrer_user_id, SocketEvents.REFERRAL_ACTIVATED, {
      referralId: referral.id,
      timestamp: new Date(),
    });
  }

  // Record the earning with 30-day hold
  await client.query(
    `INSERT INTO referral_earnings (referral_id, referrer_user_id, source_type, source_id, gross_amount, earning_amount, currency, status, available_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW() + INTERVAL '30 days')`,
    [referral.id, referral.referrer_user_id, sourceType, sourceId, grossAmount, earningAmount, currency]
  );

  // Notify referrer about new earning
  socketService.emitToUser(referral.referrer_user_id, SocketEvents.REFERRAL_EARNING, {
    sourceType,
    earningAmount,
    currency,
    timestamp: new Date(),
  });

  logger.info('[Referral] Earning recorded', {
    referralId: referral.id,
    referrerUserId: referral.referrer_user_id,
    referredUserId,
    sourceType,
    sourceId,
    grossAmount,
    earningAmount,
    currency,
  });
}

/**
 * Clawback referral earnings by source_id (payment_intent or invoice ID).
 * Used when a charge is refunded, ticket is refunded, etc.
 * Only claws back earnings still in 'pending' or 'available' status — already-paid earnings are not reversed.
 */
export async function clawbackReferralEarnings(sourceId: string, reason: string) {
  try {
    const result = await query<{
      id: string;
      referrer_user_id: string;
      earning_amount: string;
      status: string;
      currency: string;
    }>(
      `UPDATE referral_earnings
       SET status = 'clawed_back', clawed_back_at = NOW(), clawed_back_reason = $2
       WHERE source_id = $1 AND status IN ('pending', 'available')
       RETURNING id, referrer_user_id, earning_amount, status, currency`,
      [sourceId, reason]
    );

    if (result.length > 0) {
      const referrerIds = [...new Set(result.map(r => r.referrer_user_id))];
      for (const referrerId of referrerIds) {
        const totalClawedBack = result
          .filter(r => r.referrer_user_id === referrerId)
          .reduce((sum, r) => sum + parseFloat(r.earning_amount), 0);

        socketService.emitToUser(referrerId, SocketEvents.REFERRAL_CLAWBACK, {
          reason,
          amount: totalClawedBack,
          currency: result[0].currency,
          timestamp: new Date(),
        });
      }

      logger.info('[Referral] Earnings clawed back', {
        sourceId,
        reason,
        count: result.length,
        earningIds: result.map(r => r.id),
      });
    }
  } catch (error) {
    logger.error('[Referral] Failed to clawback earnings', { sourceId, reason, error });
  }
}

/**
 * Clawback all pending/available subscription earnings for a referred user.
 * Used when a subscription is cancelled/deleted.
 */
export async function clawbackSubscriptionEarnings(referredUserId: string, reason: string) {
  try {
    const result = await query<{
      id: string;
      referrer_user_id: string;
      earning_amount: string;
      currency: string;
    }>(
      `UPDATE referral_earnings
       SET status = 'clawed_back', clawed_back_at = NOW(), clawed_back_reason = $2
       WHERE referral_id IN (SELECT id FROM referrals WHERE referred_user_id = $1)
         AND source_type = 'subscription'
         AND status IN ('pending', 'available')
       RETURNING id, referrer_user_id, earning_amount, currency`,
      [referredUserId, reason]
    );

    if (result.length > 0) {
      const referrerId = result[0].referrer_user_id;
      const totalClawedBack = result.reduce((sum, r) => sum + parseFloat(r.earning_amount), 0);

      socketService.emitToUser(referrerId, SocketEvents.REFERRAL_CLAWBACK, {
        reason,
        amount: totalClawedBack,
        currency: result[0].currency,
        timestamp: new Date(),
      });

      logger.info('[Referral] Subscription earnings clawed back', {
        referredUserId,
        referrerId,
        reason,
        count: result.length,
        totalClawedBack,
      });
    }
  } catch (error) {
    logger.error('[Referral] Failed to clawback subscription earnings', { referredUserId, reason, error });
  }
}
