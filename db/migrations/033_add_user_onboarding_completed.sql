-- Migration: Add onboarding_completed column to users table
-- This tracks whether a user has completed the app onboarding flow (Tap to Pay setup)

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;

-- Add index for querying users who haven't completed onboarding
CREATE INDEX IF NOT EXISTS idx_users_onboarding_completed ON users(onboarding_completed) WHERE onboarding_completed = FALSE;

COMMENT ON COLUMN users.onboarding_completed IS 'Whether the user has completed the mobile app onboarding flow';
