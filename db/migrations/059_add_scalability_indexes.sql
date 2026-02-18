-- Migration 059: Add composite indexes for scalability
-- Covers common query patterns not yet indexed

-- Orders: webhook refund lookups by stripe_charge_id
CREATE INDEX IF NOT EXISTS idx_orders_stripe_charge
  ON orders(stripe_charge_id) WHERE stripe_charge_id IS NOT NULL;

-- Orders: per-catalog analytics (revenue by catalog, order listing filtered by catalog)
CREATE INDEX IF NOT EXISTS idx_orders_org_catalog_created
  ON orders(organization_id, catalog_id, created_at DESC);

-- Catalog products: sorted display within a category (product grid/list view)
CREATE INDEX IF NOT EXISTS idx_catalog_products_category_sort
  ON catalog_products(catalog_id, category_id, sort_order) WHERE is_active = true;

-- Events: org event listing sorted by date (dashboard event list)
CREATE INDEX IF NOT EXISTS idx_events_org_starts_at
  ON events(organization_id, starts_at DESC);

-- Sessions: cleanup expired sessions and per-user session validation
CREATE INDEX IF NOT EXISTS idx_sessions_user_expires
  ON sessions(user_id, expires_at);

-- Subscriptions: active subscription lookup per org (used on most authenticated requests)
CREATE INDEX IF NOT EXISTS idx_subscriptions_org_status_platform
  ON subscriptions(organization_id, status, platform);

-- Invoices: per-customer invoice history
CREATE INDEX IF NOT EXISTS idx_invoices_org_customer
  ON invoices(organization_id, customer_id) WHERE customer_id IS NOT NULL;

-- Preorders: per-catalog preorder listing (vendor management dashboard)
CREATE INDEX IF NOT EXISTS idx_preorders_catalog_status_created
  ON preorders(catalog_id, status, created_at DESC);

-- Tickets: event check-in lookup (scan flow queries by event + status)
CREATE INDEX IF NOT EXISTS idx_tickets_event_status
  ON tickets(event_id, status);

-- Audit logs: per-org recent activity (composite replaces two single-column indexes)
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created
  ON audit_logs(organization_id, created_at DESC);
