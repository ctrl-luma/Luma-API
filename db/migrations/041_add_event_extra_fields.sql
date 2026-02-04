-- Add additional vendor-configurable fields to events

ALTER TABLE events ADD COLUMN IF NOT EXISTS max_tickets_per_order INTEGER NOT NULL DEFAULT 10;
ALTER TABLE events ADD COLUMN IF NOT EXISTS refund_policy VARCHAR(300);
ALTER TABLE events ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
ALTER TABLE events ADD COLUMN IF NOT EXISTS age_restriction VARCHAR(100);
