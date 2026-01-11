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
