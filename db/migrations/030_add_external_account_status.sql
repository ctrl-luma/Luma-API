-- Add external account status and payout status fields to stripe_connected_accounts
ALTER TABLE stripe_connected_accounts
ADD COLUMN IF NOT EXISTS external_account_status VARCHAR(50),
ADD COLUMN IF NOT EXISTS payout_status VARCHAR(50),
ADD COLUMN IF NOT EXISTS payout_failure_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS payout_failure_message TEXT;

-- external_account_status: 'new', 'validated', 'verified', 'verification_failed', 'errored'
-- payout_status: 'active', 'undeliverable', 'restricted'
-- payout_failure_code: Stripe's failure code like 'insufficient_funds', 'account_closed', etc.
-- payout_failure_message: Human-readable failure message
