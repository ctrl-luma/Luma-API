-- Add clawback support to referral_earnings
ALTER TABLE referral_earnings ADD COLUMN IF NOT EXISTS clawed_back_at TIMESTAMPTZ;
ALTER TABLE referral_earnings ADD COLUMN IF NOT EXISTS clawed_back_reason VARCHAR(255);

-- Index for finding earnings by source_id (needed for clawback lookups)
CREATE INDEX IF NOT EXISTS idx_referral_earnings_source ON referral_earnings(source_id);
