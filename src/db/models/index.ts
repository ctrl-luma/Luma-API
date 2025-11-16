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
  created_at: Date;
  updated_at: Date;
}

export interface Event {
  id: string;
  organization_id: string;
  name: string;
  venue_name: string | null;
  location_address: string | null;
  location_lat: number | null;
  location_lng: number | null;
  start_time: Date;
  end_time: Date | null;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  settings: Record<string, any>;
  tip_settings: {
    enabled: boolean;
    default_percentages: number[];
  };
  revenue_split: Array<{
    name: string;
    type: string;
    percentage: number;
    stripe_account_id?: string;
  }>;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MenuCategory {
  id: string;
  organization_id: string;
  name: string;
  display_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface MenuItem {
  id: string;
  organization_id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price: number;
  tax_rate: number;
  sku: string | null;
  quick_add: boolean;
  display_order: number;
  is_active: boolean;
  modifiers: Array<{
    id: string;
    name: string;
    options: Array<{
      id: string;
      name: string;
      price: number;
    }>;
    required: boolean;
    max_selections: number;
  }>;
  created_at: Date;
  updated_at: Date;
}

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

export interface Session {
  id: string;
  user_id: string;
  refresh_token: string;
  device_info: Record<string, any>;
  expires_at: Date;
  created_at: Date;
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

export * from './subscription';