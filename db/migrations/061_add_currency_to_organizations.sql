-- Add currency column to organizations table
-- Defaults to 'usd' for all existing accounts
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'usd';

-- Backfill from stripe_connected_accounts for existing orgs that have completed Stripe onboarding
UPDATE organizations o
SET currency = sca.default_currency
FROM stripe_connected_accounts sca
WHERE sca.organization_id = o.id
AND sca.default_currency IS NOT NULL
AND sca.default_currency != '';
