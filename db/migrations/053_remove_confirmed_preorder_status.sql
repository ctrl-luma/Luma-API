-- Migration 053: Remove 'confirmed' from preorder_status enum
-- Simplifies flow: pending → preparing → ready → picked_up (or cancelled)

DO $$
BEGIN
  -- Step 1: Add a temporary text column, copy data, drop old column
  EXECUTE 'ALTER TABLE preorders ADD COLUMN status_new TEXT';
  EXECUTE 'UPDATE preorders SET status_new = status::text';
  EXECUTE 'UPDATE preorders SET status_new = ''preparing'' WHERE status_new = ''confirmed''';
  EXECUTE 'ALTER TABLE preorders DROP COLUMN status';

  -- Step 2: Drop old enum types
  EXECUTE 'DROP TYPE IF EXISTS preorder_status_old';
  EXECUTE 'DROP TYPE IF EXISTS preorder_status';

  -- Step 3: Create clean enum
  EXECUTE $e$CREATE TYPE preorder_status AS ENUM (
    'pending', 'preparing', 'ready', 'picked_up', 'cancelled'
  )$e$;

  -- Step 4: Convert text column to enum and rename
  EXECUTE 'ALTER TABLE preorders ALTER COLUMN status_new TYPE preorder_status USING status_new::preorder_status';
  EXECUTE 'ALTER TABLE preorders RENAME COLUMN status_new TO status';
  EXECUTE 'ALTER TABLE preorders ALTER COLUMN status SET NOT NULL';
  EXECUTE 'ALTER TABLE preorders ALTER COLUMN status SET DEFAULT ''pending''::preorder_status';
END
$$;
