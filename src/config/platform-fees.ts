/**
 * Platform Fee Configuration
 *
 * This is the single source of truth for all platform transaction fees.
 * Fees are collected on top of Stripe's processing fees via application_fee_amount.
 *
 * Default fees (US/CA/AU/NZ/SG/MY) are lower because Stripe's base rates
 * are higher in those regions. EU/UK fees are higher because Stripe's base
 * is significantly lower (1.4% vs 2.7%), keeping total rates competitive.
 */

export type SubscriptionTier = 'starter' | 'pro' | 'enterprise';

export interface PlatformFeeConfig {
  /** Percentage rate as decimal (e.g., 0.002 = 0.2%) */
  percentRate: number;
  /** Fixed fee in smallest currency unit (cents, pence, øre, etc.) */
  fixedCents: number;
  /** Human-readable description */
  description: string;
}

/**
 * Default platform fees (US/CA and other non-EU/UK regions)
 */
export const PLATFORM_FEES: Record<SubscriptionTier, PlatformFeeConfig> = {
  starter: {
    percentRate: 0.002,
    fixedCents: 3,
    description: '0.2% + 3',
  },
  pro: {
    percentRate: 0.001,
    fixedCents: 1,
    description: '0.1% + 1',
  },
  enterprise: {
    percentRate: 0,
    fixedCents: 0,
    description: 'Custom pricing',
  },
};

/**
 * Regional platform fee overrides by currency.
 *
 * EU/UK: Stripe base is ~1.4% (vs 2.7% in US), so we take a larger markup
 * while still keeping total customer rates well below US levels.
 *
 * Target total TTP rates for EU/UK:
 *   Starter: 1.9% + local equivalent of €0.25
 *   Pro:     1.8% + local equivalent of €0.22
 *
 * Fixed fees for non-EUR currencies are scaled to approximate EUR equivalents.
 */
const REGIONAL_FEES: Record<string, Record<'starter' | 'pro', Omit<PlatformFeeConfig, 'description'>>> = {
  // EUR countries (IE, FR, DE, ES, IT, NL, BE, AT, PT, FI, LU)
  eur: {
    starter: { percentRate: 0.005, fixedCents: 5 },
    pro:     { percentRate: 0.004, fixedCents: 2 },
  },
  // United Kingdom
  gbp: {
    starter: { percentRate: 0.005, fixedCents: 5 },
    pro:     { percentRate: 0.004, fixedCents: 2 },
  },
  // Switzerland
  chf: {
    starter: { percentRate: 0.005, fixedCents: 5 },
    pro:     { percentRate: 0.004, fixedCents: 2 },
  },
  // Sweden (1 SEK ≈ €0.09 → 5 EUR cents ≈ 55 öre)
  sek: {
    starter: { percentRate: 0.005, fixedCents: 55 },
    pro:     { percentRate: 0.004, fixedCents: 22 },
  },
  // Denmark (1 DKK ≈ €0.13 → 5 EUR cents ≈ 38 øre)
  dkk: {
    starter: { percentRate: 0.005, fixedCents: 38 },
    pro:     { percentRate: 0.004, fixedCents: 15 },
  },
  // Norway (1 NOK ≈ €0.09 → 5 EUR cents ≈ 55 øre)
  nok: {
    starter: { percentRate: 0.005, fixedCents: 55 },
    pro:     { percentRate: 0.004, fixedCents: 22 },
  },
  // Czechia (1 CZK ≈ €0.04 → 5 EUR cents ≈ 125 haléřů)
  czk: {
    starter: { percentRate: 0.005, fixedCents: 125 },
    pro:     { percentRate: 0.004, fixedCents: 50 },
  },
};

/**
 * Get the fee configuration for a subscription tier and currency.
 * Returns regional override if one exists, otherwise default.
 */
export function getPlatformFeeConfig(
  tier: SubscriptionTier,
  currency?: string
): PlatformFeeConfig {
  if (tier === 'enterprise') return PLATFORM_FEES.enterprise;

  const effectiveTier = (tier === 'starter' || tier === 'pro') ? tier : 'starter';

  if (currency) {
    const regional = REGIONAL_FEES[currency.toLowerCase()]?.[effectiveTier];
    if (regional) {
      return { ...regional, description: `${regional.percentRate * 100}% + ${regional.fixedCents}` };
    }
  }

  return PLATFORM_FEES[effectiveTier] || PLATFORM_FEES.starter;
}

/**
 * Calculate platform fee in smallest currency unit for a given amount and tier.
 *
 * @param amountCents - Transaction amount in smallest currency unit
 * @param tier - Subscription tier (defaults to 'starter')
 * @param currency - ISO currency code (optional, enables regional pricing)
 * @returns Platform fee in smallest currency unit (always non-negative)
 */
export function calculatePlatformFee(
  amountCents: number,
  tier: SubscriptionTier = 'starter',
  currency?: string
): number {
  const feeConfig = getPlatformFeeConfig(tier, currency);
  const fee = Math.round(amountCents * feeConfig.percentRate) + feeConfig.fixedCents;
  return Math.max(0, fee);
}
