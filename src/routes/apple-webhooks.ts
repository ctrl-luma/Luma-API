import { Hono } from 'hono';
import { logger } from '../utils/logger';
import { query } from '../db';
import { DEFAULT_FEATURES_BY_TIER, PRICING_BY_TIER } from '../db/models/subscription';
import { staffService } from '../services/staff';
import { socketService, SocketEvents } from '../services/socket';
import { cacheService, CacheKeys } from '../services/redis/cache';

const app = new Hono();

/**
 * Apple App Store Server Notifications v2
 *
 * This endpoint receives notifications from Apple about subscription events.
 * Apple sends a signed JWT (JWS) that we need to verify and decode.
 *
 * For production, you need to:
 * 1. Configure this URL in App Store Connect → App → App Store Server Notifications
 * 2. Download Apple's root certificates for signature verification
 * 3. Verify the JWS signature (currently simplified for MVP)
 *
 * See: https://developer.apple.com/documentation/appstoreservernotifications
 */

interface AppleNotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data: {
    appAppleId?: number;
    bundleId?: string;
    bundleVersion?: string;
    environment?: 'Sandbox' | 'Production';
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
  version: string;
  signedDate: number;
}

interface AppleTransactionInfo {
  transactionId: string;
  originalTransactionId: string;
  webOrderLineItemId?: string;
  bundleId: string;
  productId: string;
  subscriptionGroupIdentifier?: string;
  purchaseDate: number;
  originalPurchaseDate: number;
  expiresDate?: number;
  quantity: number;
  type: 'Auto-Renewable Subscription' | 'Non-Renewing Subscription' | 'Consumable' | 'Non-Consumable';
  inAppOwnershipType: 'PURCHASED' | 'FAMILY_SHARED';
  signedDate: number;
  environment: 'Sandbox' | 'Production';
  transactionReason?: 'PURCHASE' | 'RENEWAL';
  storefront?: string;
  storefrontId?: string;
  price?: number;
  currency?: string;
}

interface AppleRenewalInfo {
  autoRenewProductId: string;
  autoRenewStatus: 0 | 1;
  environment: 'Sandbox' | 'Production';
  expirationIntent?: number;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  offerIdentifier?: string;
  offerType?: number;
  originalTransactionId: string;
  priceIncreaseStatus?: number;
  productId: string;
  recentSubscriptionStartDate?: number;
  renewalDate?: number;
  signedDate: number;
}

// Simple base64url decode (for JWS payload)
function base64UrlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - str.length % 4) % 4);
  const base64 = str + padding;
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// Decode JWS without verification (for MVP - in production, verify signature)
function decodeJWS<T>(jws: string): T | null {
  try {
    const parts = jws.split('.');
    if (parts.length !== 3) return null;
    const payload = base64UrlDecode(parts[1]);
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

app.post('/apple/webhook', async (c) => {
  const rawBody = await c.req.text();

  logger.info('Apple webhook received', {
    contentLength: rawBody.length,
  });

  try {
    const body = JSON.parse(rawBody);
    const signedPayload = body.signedPayload;

    if (!signedPayload) {
      logger.error('No signedPayload in Apple webhook');
      return c.json({ error: 'Missing signedPayload' }, 400);
    }

    // Decode the signed payload (JWS)
    // In production, you should verify the signature using Apple's root certificates
    const payload = decodeJWS<AppleNotificationPayload>(signedPayload);

    if (!payload) {
      logger.error('Failed to decode Apple notification payload');
      return c.json({ error: 'Invalid payload' }, 400);
    }

    logger.info('Apple notification decoded', {
      notificationType: payload.notificationType,
      subtype: payload.subtype,
      notificationUUID: payload.notificationUUID,
      environment: payload.data.environment,
    });

    // Decode transaction info if present
    let transactionInfo: AppleTransactionInfo | null = null;
    if (payload.data.signedTransactionInfo) {
      transactionInfo = decodeJWS<AppleTransactionInfo>(payload.data.signedTransactionInfo);
    }

    // Decode renewal info if present
    let renewalInfo: AppleRenewalInfo | null = null;
    if (payload.data.signedRenewalInfo) {
      renewalInfo = decodeJWS<AppleRenewalInfo>(payload.data.signedRenewalInfo);
    }

    // Handle notification based on type
    switch (payload.notificationType) {
      case 'SUBSCRIBED':
        // New subscription or resubscription
        if (transactionInfo) {
          await handleAppleSubscribed(transactionInfo, renewalInfo);
        }
        break;

      case 'DID_RENEW':
        // Subscription successfully renewed
        if (transactionInfo) {
          await handleAppleRenewed(transactionInfo, renewalInfo);
        }
        break;

      case 'DID_FAIL_TO_RENEW':
        // Renewal failed (billing issue)
        if (transactionInfo && renewalInfo) {
          await handleAppleRenewalFailed(transactionInfo, renewalInfo);
        }
        break;

      case 'EXPIRED':
        // Subscription expired
        if (transactionInfo) {
          await handleAppleExpired(transactionInfo, payload.subtype);
        }
        break;

      case 'DID_CHANGE_RENEWAL_STATUS':
        // User enabled/disabled auto-renew
        if (renewalInfo && transactionInfo) {
          await handleAppleRenewalStatusChanged(transactionInfo, renewalInfo);
        }
        break;

      case 'GRACE_PERIOD_EXPIRED':
        // Grace period ended without successful payment
        if (transactionInfo) {
          await handleAppleGracePeriodExpired(transactionInfo);
        }
        break;

      case 'REFUND':
        // User was refunded
        if (transactionInfo) {
          await handleAppleRefund(transactionInfo);
        }
        break;

      case 'REVOKE':
        // Family sharing access revoked
        if (transactionInfo) {
          await handleAppleRevoke(transactionInfo);
        }
        break;

      default:
        logger.info('Unhandled Apple notification type', {
          notificationType: payload.notificationType,
          subtype: payload.subtype,
        });
    }

    return c.json({ received: true });

  } catch (error) {
    logger.error('Error processing Apple webhook', { error });
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

async function handleAppleSubscribed(transaction: AppleTransactionInfo, _renewal: AppleRenewalInfo | null) {
  const { originalTransactionId, productId, expiresDate } = transaction;

  logger.info('Apple subscription started', {
    originalTransactionId,
    productId,
    expiresDate: expiresDate ? new Date(expiresDate) : null,
  });

  // Find subscription by Apple original transaction ID
  const subRows = await query(
    `SELECT s.*, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.apple_original_transaction_id = $1`,
    [originalTransactionId]
  );

  if (subRows.length === 0) {
    // This might be a new subscription that was validated via receipt
    // The subscription should have been created when the user purchased in-app
    logger.warn('Subscription not found for Apple transaction', { originalTransactionId });
    return;
  }

  const sub = subRows[0];

  await query(
    `UPDATE subscriptions
     SET status = 'active',
         tier = 'pro',
         current_period_end = $1,
         monthly_price = $2,
         transaction_fee_rate = $3,
         features = $4,
         cancel_at = NULL,
         canceled_at = NULL,
         updated_at = NOW()
     WHERE id = $5`,
    [
      expiresDate ? new Date(expiresDate) : null,
      2999, // $29.99
      PRICING_BY_TIER.pro.transaction_fee_rate,
      DEFAULT_FEATURES_BY_TIER.pro,
      sub.id,
    ]
  );

  // Invalidate user cache since subscription data is included in /auth/me
  await cacheService.del(CacheKeys.user(sub.user_id));
  if (sub.user_email) {
    await cacheService.del(CacheKeys.userByEmail(sub.user_email));
  }

  // Re-enable staff accounts if needed
  try {
    await staffService.enableAllStaff(sub.organization_id);
  } catch (error) {
    logger.error('Failed to enable staff accounts', { error, organizationId: sub.organization_id });
  }

  // Emit socket event so app UI updates
  socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
    status: 'active',
    tier: 'pro',
    platform: 'apple',
  });
}

async function handleAppleRenewed(transaction: AppleTransactionInfo, _renewal: AppleRenewalInfo | null) {
  const { originalTransactionId, expiresDate } = transaction;

  logger.info('Apple subscription renewed', {
    originalTransactionId,
    newExpiresDate: expiresDate ? new Date(expiresDate) : null,
  });

  // Get the subscription to find organization_id for socket event
  const subRows = await query<{ id: string; organization_id: string; user_id: string; user_email: string }>(
    `SELECT s.id, s.user_id, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.apple_original_transaction_id = $1`,
    [originalTransactionId]
  );

  await query(
    `UPDATE subscriptions
     SET status = 'active',
         current_period_end = $1,
         updated_at = NOW()
     WHERE apple_original_transaction_id = $2`,
    [
      expiresDate ? new Date(expiresDate) : null,
      originalTransactionId,
    ]
  );

  // Emit socket event so app UI updates
  if (subRows.length > 0) {
    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(subRows[0].user_id));
    if (subRows[0].user_email) {
      await cacheService.del(CacheKeys.userByEmail(subRows[0].user_email));
    }

    socketService.emitToOrganization(subRows[0].organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'active',
      tier: 'pro',
      platform: 'apple',
    });
  }
}

async function handleAppleRenewalFailed(transaction: AppleTransactionInfo, renewal: AppleRenewalInfo) {
  const { originalTransactionId } = transaction;
  const { gracePeriodExpiresDate, isInBillingRetryPeriod } = renewal;

  logger.info('Apple subscription renewal failed', {
    originalTransactionId,
    gracePeriodExpiresDate: gracePeriodExpiresDate ? new Date(gracePeriodExpiresDate) : null,
    isInBillingRetryPeriod,
  });

  // Get the subscription to find organization_id for socket event
  const subRows = await query<{ id: string; organization_id: string; user_id: string; user_email: string }>(
    `SELECT s.id, s.user_id, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.apple_original_transaction_id = $1`,
    [originalTransactionId]
  );

  // Set to past_due but don't cancel yet (Apple has grace period and retry)
  await query(
    `UPDATE subscriptions
     SET status = 'past_due',
         updated_at = NOW()
     WHERE apple_original_transaction_id = $1`,
    [originalTransactionId]
  );

  // Emit socket event so app UI updates
  if (subRows.length > 0) {
    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(subRows[0].user_id));
    if (subRows[0].user_email) {
      await cacheService.del(CacheKeys.userByEmail(subRows[0].user_email));
    }

    socketService.emitToOrganization(subRows[0].organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'past_due',
      tier: 'pro',
      platform: 'apple',
    });
  }
}

async function handleAppleExpired(transaction: AppleTransactionInfo, subtype?: string) {
  const { originalTransactionId } = transaction;

  logger.info('Apple subscription expired', {
    originalTransactionId,
    subtype,
  });

  const subRows = await query<{ id: string; organization_id: string; user_id: string; user_email: string }>(
    `SELECT s.id, s.user_id, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.apple_original_transaction_id = $1`,
    [originalTransactionId]
  );

  if (subRows.length > 0) {
    const sub = subRows[0];

    await query(
      `UPDATE subscriptions
       SET status = 'canceled',
           tier = 'starter',
           features = $1,
           canceled_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [DEFAULT_FEATURES_BY_TIER.starter, sub.id]
    );

    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(sub.user_id));
    if (sub.user_email) {
      await cacheService.del(CacheKeys.userByEmail(sub.user_email));
    }

    // Disable staff accounts
    try {
      await staffService.disableAllStaff(sub.organization_id);
    } catch (error) {
      logger.error('Failed to disable staff accounts', { error, organizationId: sub.organization_id });
    }

    // Emit socket event so app UI updates
    socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'canceled',
      tier: 'starter',
      platform: 'apple',
    });
  }
}

async function handleAppleRenewalStatusChanged(transaction: AppleTransactionInfo, renewal: AppleRenewalInfo) {
  const { originalTransactionId } = transaction;
  const { autoRenewStatus, expirationIntent } = renewal;

  logger.info('Apple subscription renewal status changed', {
    originalTransactionId,
    autoRenewStatus,
    expirationIntent,
  });

  // Get the subscription to find organization_id for socket event
  const subRows = await query<{ id: string; organization_id: string; status: string; tier: string; user_id: string; user_email: string }>(
    `SELECT s.id, s.user_id, u.organization_id, s.status, s.tier, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.apple_original_transaction_id = $1`,
    [originalTransactionId]
  );

  if (autoRenewStatus === 0) {
    // User disabled auto-renew - subscription will end at current period
    const expiresDate = transaction.expiresDate;
    await query(
      `UPDATE subscriptions
       SET cancel_at = $1,
           canceled_at = NOW(),
           updated_at = NOW()
       WHERE apple_original_transaction_id = $2`,
      [
        expiresDate ? new Date(expiresDate) : null,
        originalTransactionId,
      ]
    );

    // Emit socket event - subscription is still active but scheduled to cancel
    if (subRows.length > 0) {
      // Invalidate user cache since subscription data is included in /auth/me
      await cacheService.del(CacheKeys.user(subRows[0].user_id));
      if (subRows[0].user_email) {
        await cacheService.del(CacheKeys.userByEmail(subRows[0].user_email));
      }

      socketService.emitToOrganization(subRows[0].organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
        status: subRows[0].status, // Still active/trialing until period ends
        tier: subRows[0].tier,
        platform: 'apple',
        cancelAt: expiresDate ? new Date(expiresDate).toISOString() : null,
      });
    }
  } else {
    // User re-enabled auto-renew
    await query(
      `UPDATE subscriptions
       SET cancel_at = NULL,
           canceled_at = NULL,
           updated_at = NOW()
       WHERE apple_original_transaction_id = $1`,
      [originalTransactionId]
    );

    // Emit socket event - cancellation reverted
    if (subRows.length > 0) {
      // Invalidate user cache since subscription data is included in /auth/me
      await cacheService.del(CacheKeys.user(subRows[0].user_id));
      if (subRows[0].user_email) {
        await cacheService.del(CacheKeys.userByEmail(subRows[0].user_email));
      }

      socketService.emitToOrganization(subRows[0].organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
        status: subRows[0].status,
        tier: subRows[0].tier,
        platform: 'apple',
        cancelAt: null,
      });
    }
  }
}

async function handleAppleGracePeriodExpired(transaction: AppleTransactionInfo) {
  // Same as expired - user didn't pay within grace period
  await handleAppleExpired(transaction, 'GRACE_PERIOD');
}

async function handleAppleRefund(transaction: AppleTransactionInfo) {
  const { originalTransactionId } = transaction;

  logger.info('Apple subscription refunded', {
    originalTransactionId,
  });

  const subRows = await query<{ id: string; organization_id: string; user_id: string; user_email: string }>(
    `SELECT s.id, s.user_id, u.organization_id, u.email as user_email
     FROM subscriptions s
     JOIN users u ON s.user_id = u.id
     WHERE s.apple_original_transaction_id = $1`,
    [originalTransactionId]
  );

  if (subRows.length > 0) {
    const sub = subRows[0];

    await query(
      `UPDATE subscriptions
       SET status = 'canceled',
           tier = 'starter',
           features = $1,
           canceled_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [DEFAULT_FEATURES_BY_TIER.starter, sub.id]
    );

    // Invalidate user cache since subscription data is included in /auth/me
    await cacheService.del(CacheKeys.user(sub.user_id));
    if (sub.user_email) {
      await cacheService.del(CacheKeys.userByEmail(sub.user_email));
    }

    // Disable staff accounts
    try {
      await staffService.disableAllStaff(sub.organization_id);
    } catch (error) {
      logger.error('Failed to disable staff accounts', { error, organizationId: sub.organization_id });
    }

    // Emit socket event so app/vendor UI updates
    socketService.emitToOrganization(sub.organization_id, SocketEvents.SUBSCRIPTION_UPDATED, {
      status: 'canceled',
      tier: 'starter',
      platform: 'apple',
      reason: 'refund',
    });
  }
}

async function handleAppleRevoke(transaction: AppleTransactionInfo) {
  // Family sharing access revoked - treat as cancellation
  await handleAppleRefund(transaction);
}

export default app;
