/**
 * Normalize email for consistent storage and comparison
 * - Convert to lowercase
 * - Trim whitespace
 * - Remove any extra spaces
 */
export function normalizeEmail(email: string): string {
  if (!email || typeof email !== 'string') {
    return '';
  }
  return email.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Compare two emails after normalization
 */
export function compareEmails(email1: string, email2: string): boolean {
  return normalizeEmail(email1) === normalizeEmail(email2);
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  
  // Basic email regex
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(normalized);
}