-- Migration 052: Add daily_number to preorders
-- Simple daily-resetting order numbers per organization (e.g., #1, #2, #3...)
-- Resets to 1 each day. Much easier to call out than PRE-YYYYMMDD-XXXX.

-- Add column
ALTER TABLE preorders ADD COLUMN IF NOT EXISTS daily_number INTEGER;

-- Backfill existing rows: assign sequential numbers per org per day
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY organization_id, DATE(created_at)
           ORDER BY created_at
         ) AS rn
  FROM preorders
)
UPDATE preorders
SET daily_number = numbered.rn
FROM numbered
WHERE preorders.id = numbered.id;

-- Make NOT NULL after backfill
ALTER TABLE preorders ALTER COLUMN daily_number SET NOT NULL;

-- Immutable function for extracting UTC date from timestamptz
-- Required because PostgreSQL index expressions must be IMMUTABLE,
-- and the built-in timestamptz→date cast depends on session timezone.
CREATE OR REPLACE FUNCTION date_utc(ts TIMESTAMPTZ) RETURNS DATE AS $$
  SELECT (ts AT TIME ZONE 'UTC')::date;
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;

-- Unique constraint prevents race condition duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_preorders_daily_number_unique
  ON preorders (organization_id, date_utc(created_at), daily_number);

-- Index for fast next-number lookup
CREATE INDEX IF NOT EXISTS idx_preorders_daily_lookup
  ON preorders (organization_id, created_at DESC);
