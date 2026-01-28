-- Add 'split' to payment_method enum for split payment orders
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'split';
