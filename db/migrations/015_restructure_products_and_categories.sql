-- Migration 015: Restructure products and categories for catalog independence
-- This migration enables:
-- 1. Products to be reused across multiple catalogs
-- 2. Products to have different prices per catalog
-- 3. Categories to be catalog-specific with icons
-- 4. Deleting catalogs doesn't delete products/categories

-- Step 1: Create catalog_products join table
CREATE TABLE IF NOT EXISTS catalog_products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    catalog_id UUID NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    price INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(catalog_id, product_id) -- Product can only be in a catalog once
);

-- Create indexes for catalog_products
CREATE INDEX IF NOT EXISTS idx_catalog_products_catalog_id ON catalog_products(catalog_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_product_id ON catalog_products(product_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_category_id ON catalog_products(category_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_active ON catalog_products(catalog_id, is_active);

-- Add trigger for catalog_products updated_at
DO $$ BEGIN
    CREATE TRIGGER update_catalog_products_updated_at BEFORE UPDATE ON catalog_products
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Step 2: Add catalog_id and icon to categories table
ALTER TABLE categories ADD COLUMN IF NOT EXISTS catalog_id UUID REFERENCES catalogs(id) ON DELETE CASCADE;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon VARCHAR(255);

-- Create index for categories catalog_id
CREATE INDEX IF NOT EXISTS idx_categories_catalog_id ON categories(catalog_id);

-- Step 3: Migrate existing product data to catalog_products
-- This preserves the current catalog-product relationships
INSERT INTO catalog_products (catalog_id, product_id, category_id, price, sort_order, is_active, created_at, updated_at)
SELECT
    catalog_id,
    id as product_id,
    category_id,
    price,
    sort_order,
    is_active,
    created_at,
    updated_at
FROM products
WHERE catalog_id IS NOT NULL
ON CONFLICT (catalog_id, product_id) DO NOTHING;

-- Step 4: Migrate categories to be catalog-specific
-- For each catalog, create catalog-specific categories for categories that are used
-- First, set catalog_id for categories based on products that reference them
DO $$
DECLARE
    cat RECORD;
    catalog RECORD;
    new_category_id UUID;
BEGIN
    -- For each category that's currently organization-wide
    FOR cat IN SELECT DISTINCT c.* FROM categories c WHERE c.catalog_id IS NULL
    LOOP
        -- Find all catalogs that have products using this category
        FOR catalog IN
            SELECT DISTINCT p.catalog_id
            FROM products p
            WHERE p.category_id = cat.id AND p.catalog_id IS NOT NULL
        LOOP
            -- Create a new category for this catalog
            INSERT INTO categories (
                catalog_id,
                organization_id,
                name,
                description,
                icon,
                sort_order,
                is_active,
                created_at,
                updated_at
            ) VALUES (
                catalog.catalog_id,
                cat.organization_id,
                cat.name,
                cat.description,
                cat.icon, -- Will be NULL initially
                cat.sort_order,
                cat.is_active,
                cat.created_at,
                cat.updated_at
            )
            RETURNING id INTO new_category_id;

            -- Update catalog_products to reference the new catalog-specific category
            UPDATE catalog_products cp
            SET category_id = new_category_id
            FROM products p
            WHERE cp.product_id = p.id
                AND cp.catalog_id = catalog.catalog_id
                AND p.category_id = cat.id;
        END LOOP;
    END LOOP;

    -- Delete old organization-wide categories that don't have a catalog_id
    DELETE FROM categories WHERE catalog_id IS NULL;
END $$;

-- Step 5: Remove catalog-specific columns from products table
-- Drop indexes first
DROP INDEX IF EXISTS idx_products_catalog_id;
DROP INDEX IF EXISTS idx_products_category;
DROP INDEX IF EXISTS idx_products_category_id;
DROP INDEX IF EXISTS idx_products_active;

-- Remove foreign key constraint and columns
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_catalog_id_fkey;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_id_fkey;
ALTER TABLE products DROP COLUMN IF EXISTS catalog_id;
ALTER TABLE products DROP COLUMN IF EXISTS price;
ALTER TABLE products DROP COLUMN IF EXISTS category_id;
ALTER TABLE products DROP COLUMN IF EXISTS category;
ALTER TABLE products DROP COLUMN IF EXISTS sort_order;
ALTER TABLE products DROP COLUMN IF EXISTS is_active;

-- Recreate simpler indexes for products
CREATE INDEX IF NOT EXISTS idx_products_organization_id ON products(organization_id);

-- Step 6: Make categories.catalog_id NOT NULL now that migration is complete
-- All categories should now have a catalog_id
ALTER TABLE categories ALTER COLUMN catalog_id SET NOT NULL;

-- Note: Products are now catalog-independent
-- Catalog-specific data (price, category, active status, sort order) is in catalog_products
