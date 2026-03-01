import { query } from '../db';

/**
 * Currency utilities for multi-currency support.
 *
 * Zero-decimal currencies (JPY, KRW, etc.) do not use fractional units.
 * Stripe expects amounts in the smallest currency unit:
 *   - USD $10.99 → 1099 (cents)
 *   - JPY ¥1099  → 1099 (yen, no subunit)
 *
 * The database stores all monetary values as DECIMAL(10,2) in the base
 * currency unit (dollars for USD, yen for JPY, etc.).
 */

// Currencies that have zero decimal places (Stripe's official list)
const ZERO_DECIMAL_CURRENCIES = [
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
];

/**
 * Check if a currency uses zero decimal places.
 */
export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.includes(currency.toLowerCase());
}

/**
 * Convert a base-unit amount (e.g. dollars) to Stripe's smallest unit (e.g. cents).
 * For USD: 10.99 → 1099
 * For JPY: 1099  → 1099 (no conversion)
 */
export function toSmallestUnit(amount: number, currency: string): number {
  if (isZeroDecimalCurrency(currency)) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}

/**
 * Convert from Stripe's smallest unit back to base-unit amount.
 * For USD: 1099 → 10.99
 * For JPY: 1099 → 1099 (no conversion)
 */
export function fromSmallestUnit(amount: number, currency: string): number {
  if (isZeroDecimalCurrency(currency)) {
    return amount;
  }
  return amount / 100;
}

/**
 * Format a base-unit monetary amount for display (e.g. in emails).
 * Uses Intl.NumberFormat for proper currency symbol and decimal handling.
 *
 * @param amount - Amount in base currency unit (dollars for USD, yen for JPY)
 * @param currency - 3-letter ISO currency code
 */
export function formatCurrency(amount: number, currency: string): string {
  const isZeroDecimal = isZeroDecimalCurrency(currency);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: isZeroDecimal ? 0 : 2,
    maximumFractionDigits: isZeroDecimal ? 0 : 2,
  }).format(amount);
}

/**
 * Format an amount that is already in Stripe's smallest unit (cents/etc).
 * Converts to base unit first, then formats.
 */
export function formatSmallestUnit(amount: number, currency: string): string {
  return formatCurrency(fromSmallestUnit(amount, currency), currency);
}

/**
 * Get the symbol for a currency code.
 */
/**
 * Get the currency for an organization from the database.
 * Returns 'usd' if not found.
 */
export async function getOrgCurrency(organizationId: string): Promise<string> {
  const rows = await query<{ currency: string }>(
    'SELECT currency FROM organizations WHERE id = $1',
    [organizationId]
  );
  return rows[0]?.currency || 'usd';
}

/**
 * Get the symbol for a currency code.
 */
export function getCurrencySymbol(currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
    .formatToParts(0)
    .find((part) => part.type === 'currency')?.value || currency.toUpperCase();
}
