-- Migration 024: Add category_id to order_items for analytics tracking
-- This allows tracking sales by category

-- Add category_id column to order_items
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id) ON DELETE SET NULL;

-- Create index for category analytics queries
CREATE INDEX IF NOT EXISTS idx_order_items_category ON order_items(category_id);

-- Create index for product analytics queries (if not exists)
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
