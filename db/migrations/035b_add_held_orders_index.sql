-- Migration 035b: Add held orders index
-- This must run AFTER 035 commits so the 'held' enum value is available

-- Add index for efficient held orders lookup per organization
CREATE INDEX IF NOT EXISTS idx_orders_held ON orders(organization_id, status) WHERE status = 'held';
