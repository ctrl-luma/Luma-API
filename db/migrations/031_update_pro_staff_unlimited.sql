-- Migration: 031_update_pro_staff_unlimited
-- Description: Update pro tier subscriptions to have unlimited staff accounts

-- Update existing pro subscriptions to have unlimited staff accounts (-1)
UPDATE subscriptions
SET features = jsonb_set(
  COALESCE(features, '{}'::jsonb),
  '{max_staff_accounts}',
  '-1'::jsonb
),
updated_at = NOW()
WHERE tier = 'pro'
AND (features IS NULL OR (features->>'max_staff_accounts')::int != -1);
