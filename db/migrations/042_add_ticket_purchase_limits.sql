-- Add max_per_customer limit to ticket_tiers
ALTER TABLE ticket_tiers ADD COLUMN max_per_customer INTEGER;

-- Add IP tracking to tickets
ALTER TABLE tickets ADD COLUMN customer_ip VARCHAR(45); -- IPv6 max length

-- Add IP and email tracking to ticket_locks for pre-purchase enforcement
ALTER TABLE ticket_locks ADD COLUMN customer_ip VARCHAR(45);
ALTER TABLE ticket_locks ADD COLUMN customer_email VARCHAR(255);

-- Index for efficient lookups during purchase limit checks
CREATE INDEX idx_tickets_event_email ON tickets(event_id, customer_email) WHERE status != 'cancelled';
CREATE INDEX idx_tickets_event_ip ON tickets(event_id, customer_ip) WHERE status != 'cancelled' AND customer_ip IS NOT NULL;
CREATE INDEX idx_ticket_locks_email ON ticket_locks(customer_email) WHERE customer_email IS NOT NULL;
CREATE INDEX idx_ticket_locks_ip ON ticket_locks(customer_ip) WHERE customer_ip IS NOT NULL;
