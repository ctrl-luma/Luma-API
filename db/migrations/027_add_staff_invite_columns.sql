-- Add staff invite columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_accepted_at TIMESTAMP WITH TIME ZONE;

-- Index for invite token lookups
CREATE INDEX IF NOT EXISTS idx_users_invite_token ON users(invite_token) WHERE invite_token IS NOT NULL;

-- Index for finding staff by organization (users where invited_by is not null)
CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by) WHERE invited_by IS NOT NULL;

-- User catalog access table (for assigning specific catalogs to staff users)
-- Admins have access to all catalogs, users only have access to assigned catalogs
CREATE TABLE IF NOT EXISTS user_catalogs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    catalog_id UUID NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, catalog_id)
);

CREATE INDEX IF NOT EXISTS idx_user_catalogs_user_id ON user_catalogs(user_id);
CREATE INDEX IF NOT EXISTS idx_user_catalogs_catalog_id ON user_catalogs(catalog_id);
