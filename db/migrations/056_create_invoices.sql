-- Migration 056: Create tables for custom vendor invoicing
-- Invoices are created via Stripe Invoices API on the connected account

-- Main invoices table
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Invoice identification
    invoice_number VARCHAR(50) NOT NULL,

    -- Customer info (snapshot at invoice time)
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    customer_name VARCHAR(255) NOT NULL,
    customer_email VARCHAR(255) NOT NULL,
    customer_phone VARCHAR(50),

    -- Stripe references (on connected account)
    stripe_invoice_id VARCHAR(255),
    stripe_customer_id VARCHAR(255),
    stripe_hosted_url TEXT,
    stripe_pdf_url TEXT,
    stripe_payment_intent_id VARCHAR(255),
    stripe_charge_id VARCHAR(255),

    -- Monetary values (DECIMAL dollars, consistent with orders/preorders)
    subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    amount_paid DECIMAL(10,2) DEFAULT 0.00,
    amount_due DECIMAL(10,2) DEFAULT 0.00,
    platform_fee_cents INTEGER DEFAULT 0,

    -- Invoice details
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    due_date DATE,
    memo TEXT,
    internal_notes TEXT,
    footer TEXT,

    -- Tracking
    sent_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    voided_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id),

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sequential invoice number per organization (unique)
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_org_number
    ON invoices(organization_id, invoice_number);

-- Stripe invoice lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_stripe_id
    ON invoices(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;

-- Common query patterns
CREATE INDEX IF NOT EXISTS idx_invoices_org_status_created
    ON invoices(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_org_due_date
    ON invoices(organization_id, due_date) WHERE status = 'open';

-- Invoice line items
CREATE TABLE IF NOT EXISTS invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,

    description VARCHAR(500) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price DECIMAL(10,2) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,

    -- Optional product reference (for autocomplete)
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,

    -- Stripe reference
    stripe_invoice_item_id VARCHAR(255),

    -- Ordering
    sort_order INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
    ON invoice_items(invoice_id, sort_order);

-- Per-org invoice number sequence for gap-free sequential numbering
CREATE TABLE IF NOT EXISTS invoice_number_sequences (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    last_number INTEGER NOT NULL DEFAULT 0,
    prefix VARCHAR(10) DEFAULT 'INV',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
