-- Migration: Add marketing_emails table
-- Description: Table to store email addresses for marketing newsletter subscriptions

CREATE TABLE IF NOT EXISTS marketing_emails (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    subscribed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    unsubscribed_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    source VARCHAR(100) DEFAULT 'website', -- website, checkout, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for quick lookups by email
CREATE INDEX IF NOT EXISTS idx_marketing_emails_email ON marketing_emails(email);

-- Index for active subscribers
CREATE INDEX IF NOT EXISTS idx_marketing_emails_active ON marketing_emails(is_active) WHERE is_active = TRUE;

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_marketing_emails_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_marketing_emails_updated_at ON marketing_emails;
CREATE TRIGGER trigger_update_marketing_emails_updated_at
    BEFORE UPDATE ON marketing_emails
    FOR EACH ROW
    EXECUTE FUNCTION update_marketing_emails_updated_at();
