-- Migration 016: Add display options for catalogs and categories
-- This migration enables:
-- 1. show_tip_screen boolean on catalogs (controls tip screen display in mobile app)
-- 2. layout_type on categories (controls how products are displayed in mobile app)

-- Add show_tip_screen to catalogs (default true for backwards compatibility)
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS show_tip_screen BOOLEAN NOT NULL DEFAULT true;

-- Add layout_type to categories (default 'grid' for backwards compatibility)
-- Valid values: 'grid', 'list', 'large-grid'
ALTER TABLE categories ADD COLUMN IF NOT EXISTS layout_type VARCHAR(50) NOT NULL DEFAULT 'grid';

-- Create index for efficient filtering by layout_type
CREATE INDEX IF NOT EXISTS idx_categories_layout_type ON categories(layout_type);
