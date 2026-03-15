-- Add 'manual' to the subscription_platform enum
-- Manual subscriptions are assigned by admins (e.g., for demo/test accounts)
-- and are not tied to any payment provider

ALTER TYPE subscription_platform ADD VALUE IF NOT EXISTS 'manual';
