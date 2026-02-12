-- Migration 057: Add branding logo to organizations for vendor-branded emails
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS branding_logo_id VARCHAR(255);
