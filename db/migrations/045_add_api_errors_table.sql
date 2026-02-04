-- API Errors table for production error tracking
CREATE TABLE IF NOT EXISTS api_errors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(255),
    error_message TEXT NOT NULL,
    error_stack TEXT,
    path VARCHAR(500),
    method VARCHAR(10),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    request_body JSONB,
    request_headers JSONB,
    status_code INTEGER DEFAULT 500,
    resolved BOOLEAN DEFAULT false,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying unresolved errors
CREATE INDEX idx_api_errors_resolved ON api_errors(resolved) WHERE resolved = false;

-- Index for querying by date
CREATE INDEX idx_api_errors_created_at ON api_errors(created_at DESC);

-- Index for querying by user
CREATE INDEX idx_api_errors_user_id ON api_errors(user_id) WHERE user_id IS NOT NULL;

-- Index for querying by organization
CREATE INDEX idx_api_errors_organization_id ON api_errors(organization_id) WHERE organization_id IS NOT NULL;
