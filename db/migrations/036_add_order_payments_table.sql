-- Migration 036: Add order_payments table for split payment support
-- Tracks individual payments when an order is paid with multiple methods

-- Table to track individual payments for split payment scenarios
CREATE TABLE IF NOT EXISTS order_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    payment_method payment_method NOT NULL, -- 'card', 'cash', 'tap_to_pay'
    amount INTEGER NOT NULL, -- Amount in cents
    tip_amount INTEGER DEFAULT 0, -- Tip portion in cents (for tip allocation)
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'failed', 'refunded'

    -- For card/tap_to_pay payments
    stripe_payment_intent_id VARCHAR(255),
    stripe_charge_id VARCHAR(255),

    -- For cash payments
    cash_tendered INTEGER, -- Amount customer gave (in cents)
    cash_change INTEGER, -- Change returned (in cents)

    -- Tracking
    processed_by UUID REFERENCES users(id) ON DELETE SET NULL, -- Staff member who processed
    device_id VARCHAR(255), -- Device that processed this payment
    notes TEXT,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for order_payments
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_status ON order_payments(status);
CREATE INDEX IF NOT EXISTS idx_order_payments_stripe_pi ON order_payments(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_order_payments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_order_payments_updated_at ON order_payments;
CREATE TRIGGER update_order_payments_updated_at
    BEFORE UPDATE ON order_payments
    FOR EACH ROW
    EXECUTE FUNCTION update_order_payments_updated_at();

-- Comments
COMMENT ON TABLE order_payments IS 'Individual payments for orders, supporting split payment scenarios';
COMMENT ON COLUMN order_payments.amount IS 'Payment amount in cents';
COMMENT ON COLUMN order_payments.tip_amount IS 'Portion of this payment allocated to tip (in cents)';
COMMENT ON COLUMN order_payments.cash_tendered IS 'For cash payments: amount customer handed over (in cents)';
COMMENT ON COLUMN order_payments.cash_change IS 'For cash payments: change returned to customer (in cents)';
