export interface Subscription {
  id: string;
  user_id: string;
  organization_id: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  tier: 'starter' | 'pro' | 'enterprise';
  status: 'trialing' | 'active' | 'canceled' | 'past_due' | 'incomplete' | 'incomplete_expired';
  current_period_start: Date | null;
  current_period_end: Date | null;
  trial_start: Date | null;
  trial_end: Date | null;
  cancel_at: Date | null;
  canceled_at: Date | null;
  monthly_price: number | null;
  transaction_fee_rate: number | null;
  features: SubscriptionFeatures;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface SubscriptionFeatures {
  max_devices?: number;
  max_events_per_month?: number;
  max_staff_accounts?: number;
  analytics_enabled?: boolean;
  api_access?: boolean;
  priority_support?: boolean;
  custom_branding?: boolean;
  advanced_reporting?: boolean;
  inventory_management?: boolean;
  multi_location?: boolean;
  webhook_notifications?: boolean;
  offline_mode_days?: number;
}

export const DEFAULT_FEATURES_BY_TIER: Record<string, SubscriptionFeatures> = {
  starter: {
    max_devices: 2,
    max_events_per_month: 10,
    max_staff_accounts: 3,
    analytics_enabled: false,
    api_access: false,
    priority_support: false,
    custom_branding: false,
    advanced_reporting: false,
    inventory_management: false,
    multi_location: false,
    webhook_notifications: false,
    offline_mode_days: 1,
  },
  pro: {
    max_devices: -1, // unlimited
    max_events_per_month: -1,
    max_staff_accounts: 20,
    analytics_enabled: true,
    api_access: false,
    priority_support: false,
    custom_branding: true,
    advanced_reporting: true,
    inventory_management: true,
    multi_location: true,
    webhook_notifications: true,
    offline_mode_days: 7,
  },
  enterprise: {
    max_devices: -1,
    max_events_per_month: -1,
    max_staff_accounts: -1,
    analytics_enabled: true,
    api_access: true,
    priority_support: true,
    custom_branding: true,
    advanced_reporting: true,
    inventory_management: true,
    multi_location: true,
    webhook_notifications: true,
    offline_mode_days: 30,
  },
};

export const PRICING_BY_TIER = {
  starter: {
    monthly_price: 0,
    transaction_fee_rate: 0.029, // 2.9%
    transaction_fee_fixed: 0.09, // $0.09
  },
  pro: {
    monthly_price: 19,
    transaction_fee_rate: 0.028, // 2.8%
    transaction_fee_fixed: 0.07, // $0.07
  },
  enterprise: {
    monthly_price: 299, // starts at
    transaction_fee_rate: 0.027, // 2.7% (negotiable)
    transaction_fee_fixed: 0.05, // $0.05
  },
};