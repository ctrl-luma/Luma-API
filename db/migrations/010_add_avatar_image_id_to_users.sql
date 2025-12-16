-- Migration: Add avatar_image_id to users table
-- This stores the ID of the user's profile picture on the image file server

ALTER TABLE users
ADD COLUMN IF NOT EXISTS avatar_image_id VARCHAR(255) DEFAULT NULL;

-- Add index for potential lookups by avatar_image_id
CREATE INDEX IF NOT EXISTS idx_users_avatar_image_id ON users(avatar_image_id) WHERE avatar_image_id IS NOT NULL;

COMMENT ON COLUMN users.avatar_image_id IS 'ID of the user profile picture stored on the image file server';
