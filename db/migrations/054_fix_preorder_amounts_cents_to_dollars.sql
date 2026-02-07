-- Fix preorder amounts: product prices are stored in cents in catalog_products,
-- but preorder amounts should be in dollars (consistent with orders table).
-- Previous code was inserting raw cent values without dividing by 100.

-- Convert preorder monetary columns from cents to dollars
UPDATE preorders
SET subtotal = subtotal / 100,
    tax_amount = tax_amount / 100,
    tip_amount = tip_amount / 100,
    total_amount = total_amount / 100
WHERE subtotal > 0;

-- Convert preorder_items unit_price from cents to dollars
UPDATE preorder_items
SET unit_price = unit_price / 100
WHERE unit_price > 0;
