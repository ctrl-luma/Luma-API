-- Add composite indexes for common query patterns

-- Orders: most analytics/dashboard queries filter by org + status + date
CREATE INDEX IF NOT EXISTS idx_orders_org_status_created
  ON orders(organization_id, status, created_at DESC);

-- Customers: listing/sorting by most recent order
CREATE INDEX IF NOT EXISTS idx_customers_org_last_order
  ON customers(organization_id, last_order_at DESC);

-- Customers: top spenders ranking
CREATE INDEX IF NOT EXISTS idx_customers_org_total_spent
  ON customers(organization_id, total_spent DESC);

-- Tickets: org-level queries for analytics (purchased_at used as timestamp)
CREATE INDEX IF NOT EXISTS idx_tickets_org_status_purchased
  ON tickets(organization_id, status, purchased_at DESC);

-- Preorders: list/analytics filter by org + status + date (existing index lacks created_at)
CREATE INDEX IF NOT EXISTS idx_preorders_org_status_created
  ON preorders(organization_id, status, created_at DESC);

-- Order items: top products analytics joins on order_id + product_id
CREATE INDEX IF NOT EXISTS idx_order_items_order_product
  ON order_items(order_id, product_id);

-- Preorder items: analytics product breakdown by catalog product
CREATE INDEX IF NOT EXISTS idx_preorder_items_catalog_product
  ON preorder_items(catalog_product_id);

-- Remove duplicate indexes on custom_plan_requests
DROP INDEX IF EXISTS idx_custom_plan_requests_user_id;
DROP INDEX IF EXISTS idx_custom_plan_requests_organization_id;
