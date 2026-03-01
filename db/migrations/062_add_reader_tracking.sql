-- Migration 062: Add terminal reader tracking to orders and payments
-- Tracks which reader/terminal processed each payment for analytics

-- Add reader columns to orders table (for single-payment checkout flow)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reader_id VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reader_label VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reader_type VARCHAR(50);

-- Add reader columns to order_payments table (for split payment flow)
ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS reader_id VARCHAR(255);
ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS reader_label VARCHAR(255);
ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS reader_type VARCHAR(50);
