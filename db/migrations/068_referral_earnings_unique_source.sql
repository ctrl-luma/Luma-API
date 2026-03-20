-- Add UNIQUE constraint on source_id to prevent duplicate referral earnings
-- from webhook replays or race conditions.
-- source_id format: 'pi_xxx:ticket:uuid' (per-ticket) or 'in_xxx' (subscription invoice)
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_earnings_source_id_unique
  ON referral_earnings (source_id);
