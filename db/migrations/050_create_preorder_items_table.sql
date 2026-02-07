-- Migration 050: Create preorder_items table
-- Stores individual items in each preorder

CREATE TABLE IF NOT EXISTS preorder_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  preorder_id UUID NOT NULL REFERENCES preorders(id) ON DELETE CASCADE,

  -- Product references (snapshot at time of order)
  catalog_product_id UUID NOT NULL,
  product_id UUID NOT NULL,

  -- Snapshot of product details at time of order
  name VARCHAR(255) NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,  -- In dollars (consistent with orders table)
  quantity INTEGER NOT NULL CHECK (quantity > 0),

  -- Customer notes for this specific item (e.g., "no onions")
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fetching items by preorder
CREATE INDEX IF NOT EXISTS idx_preorder_items_preorder ON preorder_items(preorder_id);
