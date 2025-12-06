-- Create custom plan requests table
CREATE TABLE IF NOT EXISTS custom_plan_requests (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  business_description TEXT NOT NULL,
  expected_volume TEXT,
  use_case TEXT NOT NULL,
  additional_requirements TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, contacted, approved, rejected
  contacted_at TIMESTAMP,
  approved_at TIMESTAMP,
  rejected_at TIMESTAMP,
  rejection_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_custom_plan_requests_user_id ON custom_plan_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_custom_plan_requests_organization_id ON custom_plan_requests(organization_id);
CREATE INDEX IF NOT EXISTS idx_custom_plan_requests_status ON custom_plan_requests(status);
CREATE INDEX IF NOT EXISTS idx_custom_plan_requests_created_at ON custom_plan_requests(created_at DESC);

-- Add trigger to update updated_at
DO $$ BEGIN
    CREATE TRIGGER update_custom_plan_requests_updated_at
      BEFORE UPDATE ON custom_plan_requests
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;