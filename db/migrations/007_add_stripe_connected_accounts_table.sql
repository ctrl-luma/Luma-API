-- Migration: Add stripe_connected_accounts table for Stripe Connect onboarding
-- This table stores the connected account information separately from organizations
-- to track detailed onboarding status and requirements

-- Create enum for onboarding state
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'connect_onboarding_state') THEN
        CREATE TYPE connect_onboarding_state AS ENUM ('not_started', 'incomplete', 'pending_verification', 'active', 'restricted', 'disabled');
    END IF;
END$$;

-- Create enum for account type
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stripe_account_type') THEN
        CREATE TYPE stripe_account_type AS ENUM ('standard', 'express', 'custom');
    END IF;
END$$;

-- Create the stripe_connected_accounts table
CREATE TABLE IF NOT EXISTS stripe_connected_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stripe_account_id VARCHAR(255) NOT NULL UNIQUE,
    account_type stripe_account_type NOT NULL DEFAULT 'express',

    -- Status / capability snapshot from Stripe
    charges_enabled BOOLEAN DEFAULT FALSE,
    payouts_enabled BOOLEAN DEFAULT FALSE,
    details_submitted BOOLEAN DEFAULT FALSE,

    -- Requirements tracking (cached from Stripe)
    requirements_currently_due JSONB DEFAULT '[]',
    requirements_eventually_due JSONB DEFAULT '[]',
    requirements_past_due JSONB DEFAULT '[]',
    requirements_disabled_reason VARCHAR(255),

    -- Derived onboarding state for easy UI logic
    onboarding_state connect_onboarding_state NOT NULL DEFAULT 'not_started',

    -- Account profile snapshot (non-sensitive, for display)
    country VARCHAR(2) DEFAULT 'US',
    default_currency VARCHAR(3) DEFAULT 'usd',
    business_type VARCHAR(50), -- individual, company, non_profit
    business_name VARCHAR(255),

    -- External payout info (lightweight, display only)
    external_account_last4 VARCHAR(4),
    external_account_bank_name VARCHAR(255),
    external_account_type VARCHAR(50), -- bank_account, card

    -- TOS acceptance tracking (for custom accounts or record-keeping)
    tos_acceptance_date TIMESTAMP WITH TIME ZONE,
    tos_acceptance_ip VARCHAR(45),
    tos_acceptance_user_agent TEXT,

    -- Operational timestamps
    onboarding_completed_at TIMESTAMP WITH TIME ZONE,
    last_stripe_sync_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_stripe_connected_accounts_org ON stripe_connected_accounts(organization_id);
CREATE INDEX IF NOT EXISTS idx_stripe_connected_accounts_stripe_id ON stripe_connected_accounts(stripe_account_id);
CREATE INDEX IF NOT EXISTS idx_stripe_connected_accounts_state ON stripe_connected_accounts(onboarding_state);

-- Add updated_at trigger
DROP TRIGGER IF EXISTS update_stripe_connected_accounts_updated_at ON stripe_connected_accounts;
CREATE TRIGGER update_stripe_connected_accounts_updated_at
    BEFORE UPDATE ON stripe_connected_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add unique constraint to ensure one connected account per organization
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_connected_accounts_org_unique ON stripe_connected_accounts(organization_id);
