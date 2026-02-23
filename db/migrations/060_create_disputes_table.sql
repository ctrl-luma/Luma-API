-- Migration 060: Create disputes table for tracking Stripe chargebacks
-- Level 1: Visibility-only dispute awareness from Connect webhooks

CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Stripe identifiers
    stripe_dispute_id VARCHAR(255) NOT NULL,
    stripe_charge_id VARCHAR(255) NOT NULL,
    stripe_payment_intent_id VARCHAR(255),

    -- Dispute details (stored in cents, consistent with Stripe)
    amount INTEGER NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'usd',
    reason VARCHAR(100),
    status VARCHAR(50) NOT NULL,

    -- Customer info (from Stripe charge)
    customer_email VARCHAR(255),
    customer_name VARCHAR(255),

    -- Linked Luma entities (nullable - dispute may match order, preorder, invoice, or ticket)
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    preorder_id UUID REFERENCES preorders(id) ON DELETE SET NULL,
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,

    -- Financial tracking
    is_charge_refundable BOOLEAN DEFAULT false,
    funds_withdrawn BOOLEAN DEFAULT false,
    funds_reinstated BOOLEAN DEFAULT false,

    -- Stripe Dashboard link
    stripe_dashboard_url TEXT,

    -- Evidence deadline
    evidence_due_by TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);

-- Lookup by Stripe dispute ID (unique - one row per dispute)
CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_stripe_id
    ON disputes(stripe_dispute_id);

-- Organization listing query (paginated by status and date)
CREATE INDEX IF NOT EXISTS idx_disputes_org_status
    ON disputes(organization_id, status, created_at DESC);

-- Lookup by charge ID (to link disputes to existing orders)
CREATE INDEX IF NOT EXISTS idx_disputes_charge_id
    ON disputes(stripe_charge_id);
