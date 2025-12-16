-- Add image_id column to products table for tracking uploaded images
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_id TEXT;

-- Create index for image_id lookups
CREATE INDEX IF NOT EXISTS idx_products_image_id ON products(image_id);
