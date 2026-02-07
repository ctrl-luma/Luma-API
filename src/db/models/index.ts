export interface Organization {
  id: string;
  name: string;
  stripe_account_id: string | null;
  stripe_onboarding_completed: boolean;
  settings: Record<string, any>;
  tap_to_pay_device_ids: string[] | null;
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
  onboarding_completed: boolean;
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
export type PreorderPaymentMode = 'pay_now' | 'pay_at_pickup' | 'both';

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
  // Preorder settings
  preorder_enabled: boolean;
  slug: string | null;
  preorder_payment_mode: PreorderPaymentMode;
  pickup_instructions: string | null;
  estimated_prep_time: number;
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

export type EventVisibility = 'public' | 'link_only';
export type EventStatus = 'draft' | 'published' | 'cancelled' | 'completed';
export type TicketStatus = 'valid' | 'used' | 'refunded' | 'cancelled';

export interface Event {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  location_name: string | null;
  location_address: string | null;
  latitude: number | null;
  longitude: number | null;
  starts_at: Date;
  ends_at: Date;
  sales_start_at: Date | null;
  sales_end_at: Date | null;
  image_url: string | null;
  banner_url: string | null;
  visibility: EventVisibility;
  status: EventStatus;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TicketTier {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  price: number;
  max_quantity: number | null;
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Ticket {
  id: string;
  ticket_tier_id: string;
  event_id: string;
  organization_id: string;
  customer_email: string;
  customer_name: string | null;
  qr_code: string;
  status: TicketStatus;
  used_at: Date | null;
  used_by: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  amount_paid: number;
  platform_fee_cents: number;
  purchased_at: Date;
  created_at: Date;
}

export interface TicketLock {
  id: string;
  ticket_tier_id: string;
  quantity: number;
  session_id: string;
  expires_at: Date;
  created_at: Date;
}

// Preorders (skip-the-line ordering from public menu)
export type PreorderStatus = 'pending' | 'preparing' | 'ready' | 'picked_up' | 'cancelled';
export type PreorderPaymentType = 'pay_now' | 'pay_at_pickup';

export interface Preorder {
  id: string;
  organization_id: string;
  catalog_id: string;
  order_number: string;
  // Customer info
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  // Payment
  payment_type: PreorderPaymentType;
  subtotal: number; // In dollars (DECIMAL)
  tax_amount: number;
  tip_amount: number;
  total_amount: number;
  // Stripe (for pay_now)
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  platform_fee_cents: number;
  // Status
  status: PreorderStatus;
  estimated_ready_at: Date | null;
  ready_at: Date | null;
  picked_up_at: Date | null;
  picked_up_by: string | null;
  // Notes
  order_notes: string | null;
  internal_notes: string | null;
  // Tracking
  session_id: string | null;
  customer_ip: string | null;
  // Timestamps
  created_at: Date;
  updated_at: Date;
}

export interface PreorderItem {
  id: string;
  preorder_id: string;
  catalog_product_id: string;
  product_id: string;
  name: string;
  unit_price: number; // In dollars (DECIMAL)
  quantity: number;
  notes: string | null;
  created_at: Date;
}

export interface ApiError {
  id: string;
  request_id: string | null;
  error_message: string;
  error_stack: string | null;
  path: string | null;
  method: string | null;
  user_id: string | null;
  organization_id: string | null;
  request_body: Record<string, unknown> | null;
  request_headers: Record<string, string> | null;
  status_code: number;
  resolved: boolean;
  resolved_at: Date | null;
  resolved_by: string | null;
  notes: string | null;
  created_at: Date;
}

export interface Device {
  id: string;
  device_id: string; // App-generated UUID stored in AsyncStorage
  organization_id: string;
  device_name: string | null;
  model_name: string | null;
  os_name: string | null;
  os_version: string | null;
  app_version: string | null;
  has_tap_to_pay: boolean;
  tap_to_pay_enabled_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  last_user_id: string | null;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface UserDevice {
  id: string;
  user_id: string;
  device_id: string; // References devices.id (database UUID, not app device_id)
  first_login_at: Date;
  last_login_at: Date;
  login_count: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export * from './subscription';