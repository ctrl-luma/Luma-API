-- Migration 021: Add catalog_id to orders and customers tables
-- This enables:
-- 1. Tracking which catalog an order was placed from
-- 2. Tracking customers per catalog (in addition to per organization)
-- 3. Linking orders to customer records

-- Add catalog_id to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS catalog_id UUID REFERENCES catalogs(id) ON DELETE SET NULL;

-- Add customer_id to orders table to link orders to customer records
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

-- Add catalog_id to customers table for per-catalog customer tracking
ALTER TABLE customers ADD COLUMN IF NOT EXISTS catalog_id UUID REFERENCES catalogs(id) ON DELETE SET NULL;

-- Create indexes for the new columns
CREATE INDEX IF NOT EXISTS idx_orders_catalog ON orders(catalog_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_catalog ON customers(catalog_id);

-- Update unique constraint on customers to be per organization + catalog + email
-- First drop the old index if it exists
DROP INDEX IF EXISTS idx_customers_org_email;

-- Create new unique constraint that allows same email in different catalogs
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_org_catalog_email
ON customers(organization_id, COALESCE(catalog_id, '00000000-0000-0000-0000-000000000000'::uuid), email);
