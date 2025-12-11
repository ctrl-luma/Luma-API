-- Add notification settings columns to users table
ALTER TABLE users 
ADD COLUMN email_alerts BOOLEAN DEFAULT true,
ADD COLUMN marketing_emails BOOLEAN DEFAULT true,
ADD COLUMN weekly_reports BOOLEAN DEFAULT true;

-- Add comments for documentation
COMMENT ON COLUMN users.email_alerts IS 'Receive important updates via email (transaction alerts, account updates, etc.)';
COMMENT ON COLUMN users.marketing_emails IS 'Stay updated with latest features and offers';
COMMENT ON COLUMN users.weekly_reports IS 'Get weekly summary of business performance';