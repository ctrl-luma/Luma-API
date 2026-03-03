-- Add RSVP-only flag to events
-- When true, all ticket tiers are free and no payment processing is needed
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_rsvp_only BOOLEAN DEFAULT false NOT NULL;
