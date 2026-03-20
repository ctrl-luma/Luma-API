/**
 * Content filter for public-facing text (event names, descriptions, ticket tiers, referral codes, etc.)
 * Catches offensive language and brand impersonation attempts.
 *
 * Uses word boundary matching to avoid false positives:
 *   "Classic Lager" → OK (contains "ass" but not as a standalone word)
 *   "Cocktail Menu" → OK (contains "cock" but not as a standalone word)
 *   "Shiitake Mushrooms" → OK
 */

// Words that must match as whole words (word boundary check)
// These are common words that appear as substrings in legitimate text
const BLOCKED_WORDS = [
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy',
  'faggot', 'fag', 'retard', 'slut', 'whore', 'porn', 'nazi', 'hitler',
];

// Slurs that should ALWAYS be blocked even as substrings (no legitimate use)
const BLOCKED_SUBSTRINGS = [
  'nigger', 'nigga',
];

// Multi-word brand impersonation patterns (substring match is fine for these)
const BLOCKED_BRAND_PATTERNS = [
  'luma-official', 'lumaofficial', 'luma-team', 'lumateam',
  'luma-support', 'lumasupport', 'luma-admin', 'lumaadmin',
];

// Build regex patterns with word boundaries for blocked words
const wordBoundaryRegexes = BLOCKED_WORDS.map(
  word => new RegExp(`\\b${word}\\b`, 'i')
);

/**
 * Check if text contains blocked content.
 * Uses word boundary matching for common words to avoid false positives,
 * and substring matching for slurs and brand impersonation.
 */
export function containsProfanity(text: string): boolean {
  const lower = text.toLowerCase();

  // Check slurs (always block, even as substrings)
  if (BLOCKED_SUBSTRINGS.some(s => lower.includes(s))) return true;

  // Check brand impersonation (substring match)
  if (BLOCKED_BRAND_PATTERNS.some(p => lower.includes(p))) return true;

  // Check offensive words with word boundaries (avoids "Classic", "Cocktail", etc.)
  if (wordBoundaryRegexes.some(regex => regex.test(text))) return true;

  return false;
}

/**
 * Check multiple fields for profanity. Returns the first field name that fails, or null if all pass.
 */
export function checkFieldsForProfanity(fields: Record<string, string | undefined | null>): string | null {
  for (const [fieldName, value] of Object.entries(fields)) {
    if (value && containsProfanity(value)) {
      return fieldName;
    }
  }
  return null;
}
