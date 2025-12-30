-- Migration 018: Add customers table for storing customer emails per organization
-- This enables:
-- 1. Storing customer emails for receipt sending
-- 2. Customer history tracking per organization
-- 3. Optional customer name storage

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    phone VARCHAR(50),
    total_orders INT DEFAULT 0,
    total_spent DECIMAL(10, 2) DEFAULT 0.00,
    last_order_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create unique constraint on organization_id + email
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_org_email ON customers(organization_id, email);

-- Create index for searching by email
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);

-- Create index for organization lookup
CREATE INDEX IF NOT EXISTS idx_customers_organization ON customers(organization_id);

-- Create updated_at trigger
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
