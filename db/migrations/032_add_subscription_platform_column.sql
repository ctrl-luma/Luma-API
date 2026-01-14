-- Add platform column and Apple/Google fields to subscriptions table
-- This enables multi-platform subscription support (Stripe, Apple App Store, Google Play)

-- Create platform enum type
DO $$ BEGIN
    CREATE TYPE subscription_platform AS ENUM ('stripe', 'apple', 'google');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add platform column with default 'stripe' for existing records
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS platform subscription_platform NOT NULL DEFAULT 'stripe';

-- Add Apple App Store fields
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS apple_original_transaction_id VARCHAR(255);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS apple_product_id VARCHAR(255);

-- Add Google Play fields
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS google_purchase_token TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS google_order_id VARCHAR(255);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS google_product_id VARCHAR(255);

-- Create indexes for platform-specific lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_platform ON subscriptions(platform);
CREATE INDEX IF NOT EXISTS idx_subscriptions_apple_transaction ON subscriptions(apple_original_transaction_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_google_order ON subscriptions(google_order_id);
