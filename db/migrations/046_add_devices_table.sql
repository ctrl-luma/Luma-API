-- Migration: 046_add_devices_table.sql
-- Description: Create devices table to track all devices that have connected to the system

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id VARCHAR(255) NOT NULL UNIQUE,  -- App-generated UUID stored in AsyncStorage
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    -- Device information
    device_name VARCHAR(255),        -- e.g., "John's iPhone"
    model_name VARCHAR(100),         -- e.g., "iPhone 14 Pro", "Pixel 7"
    os_name VARCHAR(50),             -- e.g., "iOS", "Android"
    os_version VARCHAR(50),          -- e.g., "17.2", "14"
    app_version VARCHAR(50),         -- e.g., "1.0.1"

    -- Capabilities
    has_tap_to_pay BOOLEAN DEFAULT FALSE,
    tap_to_pay_enabled_at TIMESTAMP WITH TIME ZONE,

    -- Activity tracking
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Metadata for future extensibility
    metadata JSONB DEFAULT '{}',

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);
CREATE INDEX IF NOT EXISTS idx_devices_organization ON devices(organization_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_user ON devices(last_user_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_devices_updated_at ON devices;
CREATE TRIGGER update_devices_updated_at
    BEFORE UPDATE ON devices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
