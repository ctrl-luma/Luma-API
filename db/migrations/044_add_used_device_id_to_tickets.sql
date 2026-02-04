-- Add used_device_id column to tickets table to track which device scanned the ticket
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS used_device_id VARCHAR(64);

-- Create index for querying scans by device
CREATE INDEX IF NOT EXISTS idx_tickets_used_device_id ON tickets(used_device_id) WHERE used_device_id IS NOT NULL;
