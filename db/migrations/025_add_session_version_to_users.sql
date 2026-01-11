-- Add session_version column for single session enforcement
-- Each login increments this value, invalidating previous sessions

ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER DEFAULT 1 NOT NULL;

-- Add index for fast lookups during auth verification
CREATE INDEX IF NOT EXISTS idx_users_session_version ON users(id, session_version);
