-- Migration 020: Add full tip settings to catalogs table
-- This enables per-catalog control over tip percentages and custom tip option

-- Add tip_percentages column (JSONB array of numbers, default [15, 18, 20, 25])
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS tip_percentages JSONB NOT NULL DEFAULT '[15, 18, 20, 25]'::jsonb;

-- Add allow_custom_tip column (default true)
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS allow_custom_tip BOOLEAN NOT NULL DEFAULT true;
