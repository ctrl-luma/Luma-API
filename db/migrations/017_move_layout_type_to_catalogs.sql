-- Migration 017: Move layout_type from categories to catalogs
-- Layout type should be per-catalog, not per-category
-- This allows the entire catalog to use a consistent layout (grid, list, large-grid)

-- Add layout_type to catalogs (default 'grid' for backwards compatibility)
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS layout_type VARCHAR(50) NOT NULL DEFAULT 'grid';

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_catalogs_layout_type ON catalogs(layout_type);

-- Remove layout_type from categories (keep column for backwards compatibility during migration)
-- Future cleanup: DROP COLUMN layout_type FROM categories after all apps updated
-- For now, we'll leave it but stop using it

-- Drop the index on categories.layout_type if it exists
DROP INDEX IF EXISTS idx_categories_layout_type;
