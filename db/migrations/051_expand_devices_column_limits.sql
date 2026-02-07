-- Expand device info column limits to accommodate longer OS strings
-- Some devices (especially emulators) return verbose OS names

ALTER TABLE devices
    ALTER COLUMN model_name TYPE VARCHAR(255),
    ALTER COLUMN os_name TYPE VARCHAR(255),
    ALTER COLUMN os_version TYPE VARCHAR(255);
