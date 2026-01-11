-- Revenue splits table for tracking venue/promoter/partner revenue sharing
-- Splits are configured per-catalog and calculated from completed orders
CREATE TABLE IF NOT EXISTS revenue_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_id UUID NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    recipient_name VARCHAR(255) NOT NULL,
    recipient_type VARCHAR(50) NOT NULL CHECK (recipient_type IN ('venue', 'promoter', 'partner', 'other')),
    percentage DECIMAL(5, 2) NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_revenue_splits_catalog ON revenue_splits(catalog_id);
CREATE INDEX IF NOT EXISTS idx_revenue_splits_org ON revenue_splits(organization_id);
CREATE INDEX IF NOT EXISTS idx_revenue_splits_active ON revenue_splits(catalog_id, is_active) WHERE is_active = true;
