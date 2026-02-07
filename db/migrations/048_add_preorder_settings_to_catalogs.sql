-- Migration 048: Add preorder settings to catalogs table
-- Enables per-catalog pre-ordering configuration

-- Enable/disable pre-ordering for this catalog
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS preorder_enabled BOOLEAN NOT NULL DEFAULT false;

-- Unique slug for public menu URL (e.g., /menu/summer-fest-bar)
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS slug VARCHAR(200);

-- Payment mode: 'pay_now', 'pay_at_pickup', or 'both'
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS preorder_payment_mode VARCHAR(20) NOT NULL DEFAULT 'both';

-- Instructions shown to customer after placing order (e.g., "Pick up at Window 3")
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS pickup_instructions TEXT;

-- Estimated prep time in minutes (shown to customer)
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS estimated_prep_time INTEGER DEFAULT 10;

-- Create unique index for slug lookups (only non-null slugs must be unique)
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalogs_slug ON catalogs(slug) WHERE slug IS NOT NULL;

-- Index for finding catalogs with preorders enabled
CREATE INDEX IF NOT EXISTS idx_catalogs_preorder_enabled ON catalogs(organization_id, preorder_enabled) WHERE preorder_enabled = true;
