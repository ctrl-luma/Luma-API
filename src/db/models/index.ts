export interface Organization {
  id: string;
  name: string;
  stripe_account_id: string | null;
  stripe_onboarding_completed: boolean;
  settings: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface User {
  id: string;
  email: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  password_hash: string | null;
  organization_id: string;
  role: 'owner' | 'user' | 'admin';
  is_active: boolean;
  cognito_user_id: string | null;
  stripe_customer_id: string | null;
  terms_accepted_at: Date | null;
  privacy_accepted_at: Date | null;
  last_login: Date | null;
  email_alerts: boolean;
  marketing_emails: boolean;
  weekly_reports: boolean;
  avatar_image_id: string | null;
  session_version: number; // For single session enforcement
  // Staff invite fields
  invited_by: string | null;
  invite_token: string | null;
  invite_expires_at: Date | null;
  invite_accepted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type StaffStatus = 'pending' | 'active' | 'disabled';

export interface Order {
  id: string;
  organization_id: string;
  event_id: string | null;
  user_id: string | null;
  order_number: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
  payment_method: 'card' | 'cash' | 'tap_to_pay' | null;
  subtotal: number;
  tax_amount: number;
  tip_amount: number;
  total_amount: number;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  notes: string | null;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  quantity: number;
  unit_price: number;
  modifiers: Array<{
    modifier_id: string;
    option_id: string;
    name: string;
    price: number;
  }>;
  notes: string | null;
  created_at: Date;
}

export interface Payout {
  id: string;
  organization_id: string;
  event_id: string | null;
  user_id: string | null;
  amount: number;
  status: 'pending' | 'processing' | 'paid' | 'failed';
  stripe_payout_id: string | null;
  stripe_transfer_id: string | null;
  type: string | null;
  description: string | null;
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AuditLog {
  id: string;
  organization_id: string | null;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  changes: Record<string, any>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
}

export type CatalogLayoutType = 'grid' | 'list' | 'large-grid' | 'compact';

export interface Catalog {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  location: string | null;
  date: string | null;
  is_active: boolean;
  show_tip_screen: boolean;
  layout_type: CatalogLayoutType; // Controls product display layout in mobile app
  created_at: Date;
  updated_at: Date;
}

export interface Category {
  id: string;
  catalog_id: string; // Categories are catalog-specific
  organization_id: string;
  name: string;
  description: string | null;
  icon: string | null; // Icon identifier/name for UI display
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Product {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  image_id: string | null;
  image_url: string | null;
  created_at: Date;
  updated_at: Date;
  // Removed: catalog_id, price, category_id, is_active, sort_order
  // These are now in CatalogProduct join table
}

export interface CatalogProduct {
  id: string;
  catalog_id: string;
  product_id: string;
  category_id: string | null;
  price: number; // Price for this product in this specific catalog
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Customer {
  id: string;
  organization_id: string;
  email: string;
  name: string | null;
  phone: string | null;
  total_orders: number;
  total_spent: number;
  last_order_at: Date | null;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export type ConnectOnboardingState = 'not_started' | 'incomplete' | 'pending_verification' | 'active' | 'restricted' | 'disabled';
export type StripeAccountType = 'standard' | 'express' | 'custom';

export interface StripeConnectedAccount {
  id: string;
  organization_id: string;
  stripe_account_id: string;
  account_type: StripeAccountType;

  // Status / capability snapshot from Stripe
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;

  // Requirements tracking (cached from Stripe)
  requirements_currently_due: string[];
  requirements_eventually_due: string[];
  requirements_past_due: string[];
  requirements_disabled_reason: string | null;

  // Derived onboarding state for easy UI logic
  onboarding_state: ConnectOnboardingState;

  // Account profile snapshot (non-sensitive, for display)
  country: string;
  default_currency: string;
  business_type: string | null;
  business_name: string | null;

  // External payout info (lightweight, display only)
  external_account_last4: string | null;
  external_account_bank_name: string | null;
  external_account_type: string | null;
  external_account_status: string | null; // 'new', 'validated', 'verified', 'verification_failed', 'errored'

  // Payout status tracking
  payout_status: string | null; // 'active', 'undeliverable', 'restricted'
  payout_failure_code: string | null; // e.g. 'insufficient_funds', 'account_closed'
  payout_failure_message: string | null; // Human-readable message

  // TOS acceptance tracking
  tos_acceptance_date: Date | null;
  tos_acceptance_ip: string | null;
  tos_acceptance_user_agent: string | null;

  // Operational timestamps
  onboarding_completed_at: Date | null;
  last_stripe_sync_at: Date | null;
  created_at: Date;
  updated_at: Date;

  // Cache invalidation flag - set when user goes to Stripe, cleared on next status fetch
  pending_stripe_sync: boolean;
}

export type TipPoolStatus = 'draft' | 'calculated' | 'finalized';

export interface TipPool {
  id: string;
  organization_id: string;
  name: string;
  start_date: Date;
  end_date: Date;
  total_tips: number; // In cents
  status: TipPoolStatus;
  notes: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface TipPoolMember {
  id: string;
  tip_pool_id: string;
  user_id: string;
  hours_worked: number; // Decimal hours
  tips_earned: number; // Individual tips in cents
  pool_share: number; // Calculated share in cents
  final_amount: number; // Final payout in cents
  created_at: Date;
  updated_at: Date;
}

export type RevenueSplitRecipientType = 'venue' | 'promoter' | 'partner' | 'other';

export interface RevenueSplit {
  id: string;
  catalog_id: string;
  organization_id: string;
  recipient_name: string;
  recipient_type: RevenueSplitRecipientType;
  percentage: number; // 0.00 to 100.00
  notes: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RevenueSplitReport {
  catalogId: string;
  catalogName: string;
  period: {
    startDate: string;
    endDate: string;
  };
  summary: {
    grossSales: number; // In cents
    totalSplitAmount: number; // In cents
    yourShare: number; // In cents
    orderCount: number;
  };
  splits: Array<{
    id: string;
    recipientName: string;
    recipientType: RevenueSplitRecipientType;
    percentage: number;
    amount: number; // Calculated amount in cents
  }>;
}

export * from './subscription';