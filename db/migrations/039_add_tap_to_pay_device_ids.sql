-- Add tap_to_pay_device_ids to organizations table
-- Stores array of device UUIDs where Tap to Pay has been enabled for this org's Stripe Connect account
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tap_to_pay_device_ids JSONB DEFAULT '[]';
