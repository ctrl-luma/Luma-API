-- Migration 023: Add tax_rate to catalogs
-- Allows vendors to set a tax rate percentage for each catalog
-- Default is 0 (no tax), stored as decimal (e.g., 8.25 for 8.25%)

ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5, 3) NOT NULL DEFAULT 0;

-- Add comment for clarity
COMMENT ON COLUMN catalogs.tax_rate IS 'Tax rate as percentage (e.g., 8.25 for 8.25%). Default 0 means no tax.';
