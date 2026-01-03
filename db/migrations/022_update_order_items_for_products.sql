-- Migration 022: Update order_items to work with products instead of menu_items
-- The order_items table references menu_items, but we use products/catalog_products

-- Drop the foreign key constraint on menu_item_id
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_menu_item_id_fkey;

-- Rename menu_item_id to product_id for clarity
ALTER TABLE order_items RENAME COLUMN menu_item_id TO product_id;

-- Add a name column to store the product name at time of order (denormalized for history)
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS name VARCHAR(255);

-- Copy any existing notes to name if they contain product names
UPDATE order_items SET name = notes WHERE name IS NULL AND notes IS NOT NULL;

-- Make product_id nullable (for quick charges without line items)
ALTER TABLE order_items ALTER COLUMN product_id DROP NOT NULL;
