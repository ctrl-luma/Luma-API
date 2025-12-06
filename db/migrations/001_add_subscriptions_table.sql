-- Create subscription status enum if not exists
DO $$ BEGIN
    CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'canceled', 'past_due', 'incomplete', 'incomplete_expired', 'pending_payment', 'pending_approval');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create subscription tier enum if not exists  
DO $$ BEGIN
    CREATE TYPE subscription_tier AS ENUM ('starter', 'pro', 'enterprise');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stripe_subscription_id VARCHAR(255) UNIQUE,
    stripe_customer_id VARCHAR(255),
    tier subscription_tier NOT NULL DEFAULT 'starter',
    status subscription_status NOT NULL DEFAULT 'trialing',
    current_period_start TIMESTAMP WITH TIME ZONE,
    current_period_end TIMESTAMP WITH TIME ZONE,
    trial_start TIMESTAMP WITH TIME ZONE,
    trial_end TIMESTAMP WITH TIME ZONE,
    cancel_at TIMESTAMP WITH TIME ZONE,
    canceled_at TIMESTAMP WITH TIME ZONE,
    monthly_price DECIMAL(10, 2),
    transaction_fee_rate DECIMAL(5, 4),
    features JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for subscriptions
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_organization ON subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tier ON subscriptions(tier);

-- Update users table to include cognito_user_id
ALTER TABLE users ADD COLUMN IF NOT EXISTS cognito_user_id VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMP WITH TIME ZONE;

-- Create index for cognito_user_id
CREATE INDEX IF NOT EXISTS idx_users_cognito ON users(cognito_user_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);

-- Add trigger for subscriptions updated_at
DO $$ BEGIN
    CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Default subscription features by tier
COMMENT ON TABLE subscriptions IS 'Subscription details with features based on tier:
Starter Tier:
- Free plan
- 2.9% + $0.09 per transaction
- Up to 2 devices
- Basic features

Pro Tier:
- $19/month
- 2.8% + $0.07 per transaction  
- Unlimited devices
- Advanced features
- Analytics dashboard

Enterprise Tier:
- $149-299/month
- Custom rate (2.6-2.7% + $0.05)
- Unlimited everything
- API access
- Priority support';