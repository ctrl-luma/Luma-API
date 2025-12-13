-- Migration: Add pending_stripe_sync flag to stripe_connected_accounts
-- This flag is set when user is redirected to Stripe for onboarding
-- and cleared after the next status check, ensuring fresh data is fetched

ALTER TABLE stripe_connected_accounts
ADD COLUMN IF NOT EXISTS pending_stripe_sync BOOLEAN DEFAULT FALSE;

-- Add comment explaining the column
COMMENT ON COLUMN stripe_connected_accounts.pending_stripe_sync IS
  'Set to true when user is redirected to Stripe onboarding. When true, the next status check will force a refresh from Stripe API and clear this flag.';
