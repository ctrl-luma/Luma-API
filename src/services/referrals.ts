import { query } from '../db';
import { logger } from '../utils/logger';
import { socketService, SocketEvents } from './socket';

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
