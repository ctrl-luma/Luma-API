-- Migration 019: Add prompt_for_email to catalogs table
-- This enables per-catalog control over whether to prompt for customer email during checkout

-- Add prompt_for_email column to catalogs (default true for backwards compatibility)
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS prompt_for_email BOOLEAN NOT NULL DEFAULT true;
