-- Add timezone column to events table
-- Stores IANA timezone identifier (e.g., "America/New_York", "Europe/London")
-- Used to display event times in the venue's local timezone

ALTER TABLE events ADD COLUMN timezone VARCHAR(50) DEFAULT 'America/New_York';

-- Update existing events to have a default timezone
UPDATE events SET timezone = 'America/New_York' WHERE timezone IS NULL;

-- Make it NOT NULL after setting defaults
ALTER TABLE events ALTER COLUMN timezone SET NOT NULL;

COMMENT ON COLUMN events.timezone IS 'IANA timezone identifier for the event venue (e.g., America/New_York)';
