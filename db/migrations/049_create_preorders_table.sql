-- Migration 049: Create preorders table
-- Stores customer pre-orders placed via public menu page

-- Preorder status enum
DO $$ BEGIN
  CREATE TYPE preorder_status AS ENUM (
    'pending',      -- Submitted, awaiting vendor acknowledgment
    'confirmed',    -- Vendor confirmed the order
    'preparing',    -- Actively being prepared
    'ready',        -- Ready for pickup
    'picked_up',    -- Customer picked up
    'cancelled'     -- Cancelled by customer or vendor
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Preorders table
CREATE TABLE IF NOT EXISTS preorders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  catalog_id UUID NOT NULL REFERENCES catalogs(id),

  -- Order identification
  order_number VARCHAR(20) NOT NULL,

  -- Customer info
  customer_name VARCHAR(200) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(50),

  -- Payment type: 'pay_now' or 'pay_at_pickup'
  payment_type VARCHAR(20) NOT NULL,

  -- Monetary values stored in DOLLARS (DECIMAL) - consistent with orders table
  subtotal DECIMAL(10,2) NOT NULL,
  tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  tip_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(10,2) NOT NULL,

  -- Stripe payment info (for pay_now orders)
  stripe_payment_intent_id VARCHAR(255),
  stripe_charge_id VARCHAR(255),
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,

  -- Status tracking
  status preorder_status NOT NULL DEFAULT 'pending',
  estimated_ready_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  picked_up_by UUID REFERENCES users(id),

  -- Notes
  order_notes TEXT,
  internal_notes TEXT,

  -- Session/fraud tracking
  session_id VARCHAR(64),
  customer_ip INET,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_preorders_org ON preorders(organization_id);
CREATE INDEX IF NOT EXISTS idx_preorders_catalog ON preorders(catalog_id);
CREATE INDEX IF NOT EXISTS idx_preorders_status ON preorders(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_preorders_customer_email ON preorders(customer_email);
CREATE INDEX IF NOT EXISTS idx_preorders_order_number ON preorders(order_number);
CREATE INDEX IF NOT EXISTS idx_preorders_created_at ON preorders(created_at DESC);

-- Index for finding active preorders (not completed or cancelled)
CREATE INDEX IF NOT EXISTS idx_preorders_active ON preorders(organization_id, catalog_id, status)
  WHERE status NOT IN ('picked_up', 'cancelled');

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_preorders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_preorders_updated_at ON preorders;
CREATE TRIGGER trigger_preorders_updated_at
  BEFORE UPDATE ON preorders
  FOR EACH ROW
  EXECUTE FUNCTION update_preorders_updated_at();
