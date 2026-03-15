-- Add account deletion tracking to users table
-- When set, the account is scheduled for permanent deletion after 30 days

ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_reminder_sent BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_deletion_requested ON users(deletion_requested_at)
  WHERE deletion_requested_at IS NOT NULL;
