-- Migration: 026_create_tip_pools.sql
-- Description: Create tip_pools and tip_pool_members tables for tip management

-- Tip pools table - represents a tip pooling period
CREATE TABLE IF NOT EXISTS tip_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  total_tips INTEGER NOT NULL DEFAULT 0,  -- Total tips in the period (in cents)
  status VARCHAR(50) NOT NULL DEFAULT 'draft',  -- 'draft', 'calculated', 'finalized'
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for tip_pools
CREATE INDEX IF NOT EXISTS idx_tip_pools_org ON tip_pools(organization_id);
CREATE INDEX IF NOT EXISTS idx_tip_pools_dates ON tip_pools(organization_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_tip_pools_status ON tip_pools(organization_id, status);

-- Tip pool members table - staff members in a tip pool with their hours and shares
CREATE TABLE IF NOT EXISTS tip_pool_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tip_pool_id UUID NOT NULL REFERENCES tip_pools(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  hours_worked DECIMAL(6, 2) NOT NULL DEFAULT 0,  -- Hours worked with decimal support
  tips_earned INTEGER NOT NULL DEFAULT 0,   -- Individual tips they took in the period (cents)
  pool_share INTEGER NOT NULL DEFAULT 0,    -- Calculated share from pool (cents)
  final_amount INTEGER NOT NULL DEFAULT 0,  -- Final payout amount (cents)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tip_pool_id, user_id)
);

-- Indexes for tip_pool_members
CREATE INDEX IF NOT EXISTS idx_tip_pool_members_pool ON tip_pool_members(tip_pool_id);
CREATE INDEX IF NOT EXISTS idx_tip_pool_members_user ON tip_pool_members(user_id);
