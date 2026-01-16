/**
 * Platform Fee Configuration
 *
 * This is the single source of truth for all platform transaction fees.
 * Fees are collected on top of Stripe's processing fees.
 *
 * Stripe's base fees (for reference):
 * - Tap to Pay (card_present): 2.7% + $0.05
 * - Manual card entry (card): 2.9% + $0.30
 */

export type SubscriptionTier = 'starter' | 'pro' | 'enterprise';

export interface PlatformFeeConfig {
  /** Percentage rate as decimal (e.g., 0.002 = 0.2%) */
  percentRate: number;
  /** Fixed fee in cents */
  fixedCents: number;
  /** Human-readable description */
  description: string;
}

/**
 * Platform fees by subscription tier
 *
 * These fees are added on top of Stripe's processing fees.
 * They are collected via application_fee_amount on direct charges.
 */
export const PLATFORM_FEES: Record<SubscriptionTier, PlatformFeeConfig> = {
  // Starter (Free) plan: 0.2% + $0.03
  starter: {
    percentRate: 0.002,
    fixedCents: 3,
    description: '0.2% + $0.03',
  },
  // Pro plan: 0.1% + $0.01
  pro: {
    percentRate: 0.001,
    fixedCents: 1,
    description: '0.1% + $0.01',
  },
  // Enterprise: custom pricing, default to no platform fee
  enterprise: {
    percentRate: 0,
    fixedCents: 0,
    description: 'Custom pricing',
  },
};

/**
 * Calculate platform fee in cents for a given amount and subscription tier
 *
 * @param amountCents - Transaction amount in cents
 * @param tier - Subscription tier (defaults to 'starter' if not provided)
 * @returns Platform fee in cents (always non-negative)
 */
export function calculatePlatformFee(
  amountCents: number,
  tier: SubscriptionTier = 'starter'
): number {
  const feeConfig = PLATFORM_FEES[tier] || PLATFORM_FEES.starter;
  const fee = Math.round(amountCents * feeConfig.percentRate) + feeConfig.fixedCents;
  return Math.max(0, fee);
}

/**
 * Get the fee configuration for a subscription tier
 *
 * @param tier - Subscription tier
 * @returns Fee configuration object
 */
export function getPlatformFeeConfig(tier: SubscriptionTier): PlatformFeeConfig {
  return PLATFORM_FEES[tier] || PLATFORM_FEES.starter;
}
