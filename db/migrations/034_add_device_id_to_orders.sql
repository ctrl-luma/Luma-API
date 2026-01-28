-- Add device_id column to orders table
-- This tracks which device processed each order

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS device_id VARCHAR(255);

-- Create index for efficient device-based queries
CREATE INDEX IF NOT EXISTS idx_orders_device_id ON orders(device_id);

-- Create composite index for organization + device queries
CREATE INDEX IF NOT EXISTS idx_orders_org_device ON orders(organization_id, device_id);

COMMENT ON COLUMN orders.device_id IS 'Unique identifier of the device that processed this order';
