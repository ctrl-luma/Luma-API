-- Migration to update user roles to simplified structure
-- This handles existing data if any

-- First, update any existing users with old roles to new roles
UPDATE users SET role = 'user' WHERE role IN ('bartender', 'barback', 'manager');

-- Now alter the enum type
ALTER TYPE user_role RENAME TO user_role_old;

CREATE TYPE user_role AS ENUM ('owner', 'user', 'admin');

ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::text::user_role;

DROP TYPE user_role_old;