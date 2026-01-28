-- Migration 037: Ensure 'held' enum value exists
-- This migration fixes potential issues with the previous migration that may have
-- failed silently due to PostgreSQL transaction limitations with ALTER TYPE ADD VALUE

-- Alternative approach: recreate the enum type with all values
-- This is safe because we're using IF NOT EXISTS checks

-- First, check if the 'held' value already exists
DO $$
BEGIN
    -- Check if 'held' already exists in the enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'held'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'transaction_status')
    ) THEN
        RAISE NOTICE 'The "held" enum value does not exist. Will attempt to add it.';
        RAISE NOTICE 'If this migration fails, run manually: ALTER TYPE transaction_status ADD VALUE ''held'';';
    ELSE
        RAISE NOTICE 'The "held" enum value already exists. No action needed.';
    END IF;
END $$;

-- Try to add 'held' using ALTER TYPE ADD VALUE IF NOT EXISTS (PostgreSQL 9.3+)
-- This will succeed silently if the value already exists
-- NOTE: This statement MUST run outside a transaction block
-- If your migration runner wraps in a transaction, this will fail.
-- In that case, run manually: ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'held';
ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'held';
