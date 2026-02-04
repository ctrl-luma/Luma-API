-- Create events and ticketing tables (Pro-only feature)

-- Drop old tables if they exist with wrong schema
DROP TABLE IF EXISTS ticket_locks CASCADE;
DROP TABLE IF EXISTS tickets CASCADE;
DROP TABLE IF EXISTS ticket_tiers CASCADE;
DROP TABLE IF EXISTS events CASCADE;

-- Events
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL UNIQUE,
  description TEXT,
  location_name VARCHAR(300),
  location_address TEXT,
  latitude DECIMAL(10,7),
  longitude DECIMAL(10,7),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  sales_start_at TIMESTAMPTZ,
  sales_end_at TIMESTAMPTZ,
  image_url TEXT,
  banner_url TEXT,
  visibility VARCHAR(20) NOT NULL DEFAULT 'public',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_org ON events(organization_id);
CREATE INDEX idx_events_slug ON events(slug);
CREATE INDEX idx_events_status_visibility ON events(status, visibility);
CREATE INDEX idx_events_starts_at ON events(starts_at);

-- Ticket Tiers
CREATE TABLE ticket_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  max_quantity INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ticket_tiers_event ON ticket_tiers(event_id);

-- Tickets (purchased)
CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_tier_id UUID NOT NULL REFERENCES ticket_tiers(id),
  event_id UUID NOT NULL REFERENCES events(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_email VARCHAR(255) NOT NULL,
  customer_name VARCHAR(200),
  qr_code VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'valid',
  used_at TIMESTAMPTZ,
  used_by UUID REFERENCES users(id),
  stripe_payment_intent_id VARCHAR(255),
  stripe_charge_id VARCHAR(255),
  amount_paid DECIMAL(10,2) NOT NULL,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  purchased_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tickets_event ON tickets(event_id);
CREATE INDEX idx_tickets_tier ON tickets(ticket_tier_id);
CREATE INDEX idx_tickets_qr ON tickets(qr_code);
CREATE INDEX idx_tickets_email ON tickets(customer_email);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_org ON tickets(organization_id);

-- Ticket Locks (5-minute checkout hold)
CREATE TABLE ticket_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_tier_id UUID NOT NULL REFERENCES ticket_tiers(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  session_id VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ticket_locks_tier ON ticket_locks(ticket_tier_id);
CREATE INDEX idx_ticket_locks_expires ON ticket_locks(expires_at);
