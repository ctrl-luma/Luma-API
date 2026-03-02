/**
 * Stripe base rates per currency and helpers to compute total customer-facing rates.
 *
 * Rates sourced from official Stripe pricing pages (March 2026).
 * Combined with platform-fees.ts markup to produce the rates shown to users.
 */

import { getPlatformFeeConfig, type SubscriptionTier } from './platform-fees';

interface StripeRate {
  percent: number;
  /** Fixed fee in smallest currency unit */
  fixed: number;
}

interface CurrencyRates {
  terminal: StripeRate;
  /** TTP surcharge added on top of terminal. null = use ttpRate. */
  ttpSurcharge: number | null;
  /** Separate TTP rate (Australia). null for most countries. */
  ttpRate: StripeRate | null;
  manualCard: StripeRate;
}

const STRIPE_RATES: Record<string, CurrencyRates> = {
  usd: {
    terminal: { percent: 2.7, fixed: 5 },
    ttpSurcharge: 10, ttpRate: null,
    manualCard: { percent: 2.9, fixed: 30 },
  },
  cad: {
    terminal: { percent: 2.7, fixed: 5 },
    ttpSurcharge: 15, ttpRate: null,
    manualCard: { percent: 2.9, fixed: 30 },
  },
  gbp: {
    terminal: { percent: 1.4, fixed: 10 },
    ttpSurcharge: 10, ttpRate: null,
    manualCard: { percent: 1.5, fixed: 20 },
  },
  aud: {
    terminal: { percent: 1.7, fixed: 10 },
    ttpSurcharge: null,
    ttpRate: { percent: 1.95, fixed: 15 },
    manualCard: { percent: 1.75, fixed: 30 },
  },
  nzd: {
    terminal: { percent: 2.6, fixed: 5 },
    ttpSurcharge: 15, ttpRate: null,
    manualCard: { percent: 2.65, fixed: 30 },
  },
  eur: {
    terminal: { percent: 1.4, fixed: 10 },
    ttpSurcharge: 10, ttpRate: null,
    manualCard: { percent: 1.5, fixed: 25 },
  },
  sek: {
    terminal: { percent: 1.4, fixed: 100 },
    ttpSurcharge: 105, ttpRate: null,
    manualCard: { percent: 1.5, fixed: 180 },
  },
  dkk: {
    terminal: { percent: 1.4, fixed: 75 },
    ttpSurcharge: 70, ttpRate: null,
    manualCard: { percent: 1.5, fixed: 180 },
  },
  nok: {
    terminal: { percent: 1.4, fixed: 100 },
    ttpSurcharge: 105, ttpRate: null,
    manualCard: { percent: 2.4, fixed: 200 },
  },
  chf: {
    terminal: { percent: 1.4, fixed: 10 },
    ttpSurcharge: 10, ttpRate: null,
    manualCard: { percent: 2.9, fixed: 30 },
  },
  czk: {
    terminal: { percent: 1.4, fixed: 225 },
    ttpSurcharge: 220, ttpRate: null,
    manualCard: { percent: 1.5, fixed: 450 },
  },
  sgd: {
    terminal: { percent: 3.4, fixed: 50 },
    ttpSurcharge: 15, ttpRate: null,
    manualCard: { percent: 3.4, fixed: 50 },
  },
  myr: {
    terminal: { percent: 2.8, fixed: 50 },
    ttpSurcharge: 45, ttpRate: null,
    manualCard: { percent: 3.0, fixed: 100 },
  },
};

function getStripeRates(currency: string): CurrencyRates {
  return STRIPE_RATES[currency.toLowerCase()] || STRIPE_RATES.usd;
}

function getTTPBase(rates: CurrencyRates): StripeRate {
  if (rates.ttpRate) return rates.ttpRate;
  return {
    percent: rates.terminal.percent,
    fixed: rates.terminal.fixed + (rates.ttpSurcharge || 0),
  };
}

const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

function formatFixed(smallestUnit: number, currency: string): string {
  const cur = currency.toLowerCase();
  const isZD = ZERO_DECIMAL.has(cur);

  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: cur.toUpperCase(),
    minimumFractionDigits: isZD ? 0 : 2,
    maximumFractionDigits: isZD ? 0 : 2,
  });

  return formatter.format(isZD ? smallestUnit : smallestUnit / 100);
}

function formatRate(stripeBase: StripeRate, tier: SubscriptionTier, currency: string): string {
  const markup = getPlatformFeeConfig(tier, currency);
  const totalPercent = +(stripeBase.percent + markup.percentRate * 100).toFixed(2);
  const totalFixed = stripeBase.fixed + markup.fixedCents;
  return `${totalPercent}% + ${formatFixed(totalFixed, currency)}`;
}

export interface ComputedRates {
  tapToPay: { starter: string; pro: string };
  manualCard: { starter: string; pro: string };
}

/**
 * Compute the total customer-facing rates for a given currency.
 * Returns formatted strings like "2.9% + $0.18" for each payment type and tier.
 */
export function getComputedRates(currency: string): ComputedRates {
  const rates = getStripeRates(currency);
  const ttp = getTTPBase(rates);

  return {
    tapToPay: {
      starter: formatRate(ttp, 'starter', currency),
      pro: formatRate(ttp, 'pro', currency),
    },
    manualCard: {
      starter: formatRate(rates.manualCard, 'starter', currency),
      pro: formatRate(rates.manualCard, 'pro', currency),
    },
  };
}
