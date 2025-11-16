-- Ensure email is indexed with lowercase for case-insensitive lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

-- Add Stripe price ID columns for subscription tiers
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_price_id VARCHAR(255);

-- Create index for stripe_price_id
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_price ON subscriptions(stripe_price_id);

-- Add comment explaining the email normalization strategy
COMMENT ON COLUMN users.email IS 'Email addresses are stored normalized (lowercase, trimmed) for consistent lookups';

-- Create a function to normalize emails on insert/update
CREATE OR REPLACE FUNCTION normalize_email() RETURNS trigger AS $$
BEGIN
  NEW.email = LOWER(TRIM(NEW.email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically normalize emails
CREATE TRIGGER normalize_user_email
  BEFORE INSERT OR UPDATE OF email ON users
  FOR EACH ROW
  EXECUTE FUNCTION normalize_email();