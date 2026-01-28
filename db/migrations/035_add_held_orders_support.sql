-- Migration 035: Add held orders support
-- Adds 'held' status for open tabs feature and tracking columns

-- Add 'held' to the transaction_status enum
-- Note: ADD VALUE cannot run inside a transaction block, and the new value
-- cannot be used until AFTER this transaction commits
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'held' AND enumtypid = 'transaction_status'::regtype) THEN
        ALTER TYPE transaction_status ADD VALUE 'held' AFTER 'pending';
    END IF;
END$$;

-- Add held_at timestamp to track when order was put on hold
ALTER TABLE orders ADD COLUMN IF NOT EXISTS held_at TIMESTAMP WITH TIME ZONE;

-- Add held_by to track which user put order on hold
ALTER TABLE orders ADD COLUMN IF NOT EXISTS held_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Add hold_name for optional label (e.g., "Table 5", "John's order")
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_name VARCHAR(100);

-- Add index for held_at for sorting (does not reference the new enum value)
CREATE INDEX IF NOT EXISTS idx_orders_held_at ON orders(held_at) WHERE held_at IS NOT NULL;

COMMENT ON COLUMN orders.held_at IS 'Timestamp when order was put on hold';
COMMENT ON COLUMN orders.held_by IS 'User who put the order on hold';
COMMENT ON COLUMN orders.hold_name IS 'Optional label for held order (e.g., Table 5, Customer name)';
