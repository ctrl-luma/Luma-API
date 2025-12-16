-- Create catalogs table
CREATE TABLE IF NOT EXISTS catalogs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    location VARCHAR(500),
    date VARCHAR(50),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for catalogs
CREATE INDEX IF NOT EXISTS idx_catalogs_organization_id ON catalogs(organization_id);
CREATE INDEX IF NOT EXISTS idx_catalogs_active ON catalogs(organization_id, is_active);

-- Add trigger for catalogs updated_at
DO $$ BEGIN
    CREATE TRIGGER update_catalogs_updated_at BEFORE UPDATE ON catalogs
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
