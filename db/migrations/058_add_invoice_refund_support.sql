-- Add refund tracking to invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_refunded DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS refund_receipt_url TEXT;
