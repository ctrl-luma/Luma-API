import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { authService } from '../services/auth';
import { stripeService, stripe } from '../services/stripe';
import { logger } from '../utils/logger';
import { config } from '../config';
import { query } from '../db';
import type { SubscriptionPlatform } from '../db/models/subscription';

const app = new OpenAPIHono();

// Cache for billing portal configuration IDs (created once, reused)
let cachedPaymentConfigId: string | null = null;
let cachedSubscriptionConfigId: string | null = null;

async function getOrCreatePortalConfigs() {
  if (cachedPaymentConfigId && cachedSubscriptionConfigId) {
    return { paymentConfigId: cachedPaymentConfigId, subscriptionConfigId: cachedSubscriptionConfigId };
  }

  // Create both configurations in parallel
  const [paymentConfig, subscriptionConfig] = await Promise.all([
    stripe.billingPortal.configurations.create({
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: false },
        subscription_cancel: { enabled: false },
        customer_update: { enabled: false },
        subscription_update: { enabled: false }
      },
      business_profile: { headline: 'Manage your payment method' }
    }),
    stripe.billingPortal.configurations.create({
      features: {
        payment_method_update: { enabled: false },
        invoice_history: { enabled: false },
        subscription_cancel: { enabled: true },
        customer_update: { enabled: false },
        subscription_update: { enabled: false }
      },
      business_profile: { headline: 'Manage your subscription' }
    })
  ]);

  cachedPaymentConfigId = paymentConfig.id;
  cachedSubscriptionConfigId = subscriptionConfig.id;

  logger.info('Portal configurations created and cached', {
    paymentConfigId: cachedPaymentConfigId,
    subscriptionConfigId: cachedSubscriptionConfigId
  });

  return { paymentConfigId: cachedPaymentConfigId, subscriptionConfigId: cachedSubscriptionConfigId };
}

// Billing history endpoint
const billingHistoryRoute = createRoute({
  method: 'get',
  path: '/billing/history',
  summary: 'Get user billing history',
  description: 'Retrieve paginated billing history for the authenticated user',
  tags: ['Billing'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.string().optional().default('1'),
      per_page: z.string().optional().default('10'),
    }),
  },
  responses: {
    200: {
      description: 'Billing history retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(z.object({
              id: z.string(),
              date: z.string(),
              amount: z.number(),
              currency: z.string(),
              status: z.enum(['paid', 'open', 'draft', 'void']),
              description: z.string().nullable(),
              invoice_url: z.string().nullable(),
              pdf_url: z.string().nullable(),
            })),
            pagination: z.object({
              page: z.number(),
              per_page: z.number(),
              total_pages: z.number(),
              total_count: z.number(),
              has_next: z.boolean(),
              has_previous: z.boolean(),
            }),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    404: {
      description: 'User not found or no Stripe customer',
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

// @ts-ignore - OpenAPI handler type mismatch
app.openapi(billingHistoryRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const user = await authService.getUserById(payload.userId);
    
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    if (!user.stripe_customer_id) {
      logger.info('User has no stripe_customer_id, returning empty billing history', {
        userId: user.id,
        email: user.email
      });
      return c.json({
        data: [],
        pagination: {
          page: 1,
          per_page: 10,
          total_pages: 0,
          total_count: 0,
          has_next: false,
          has_previous: false,
        },
      });
    }

    logger.info('Looking up billing history', {
      userId: user.id,
      stripeCustomerId: user.stripe_customer_id,
      email: user.email
    });

    const query = c.req.query();
    const page = parseInt(query.page || '1');
    const perPage = parseInt(query.per_page || '10');
    
    // Calculate Stripe pagination parameters
    const limit = Math.min(perPage, 100); // Stripe max limit is 100
    let starting_after: string | undefined;

    // For pages after the first, we need to get the starting_after cursor
    // This is a simplified pagination approach - for production, you'd want to store cursors
    if (page > 1) {
      // Get all invoices up to the current page to find the correct starting point
      const skipCount = (page - 1) * perPage;
      const previousInvoices = await stripeService.getCustomerInvoices(user.stripe_customer_id, {
        limit: skipCount,
      });
      
      if (previousInvoices.data.length > 0) {
        starting_after = previousInvoices.data[previousInvoices.data.length - 1].id;
      }
    }

    // Get the invoices for this page
    const invoices = await stripeService.getCustomerInvoices(user.stripe_customer_id, {
      limit,
      starting_after,
    });

    logger.info('Stripe invoices response', {
      customerId: user.stripe_customer_id,
      invoiceCount: invoices.data.length,
      hasMore: invoices.has_more,
      invoiceIds: invoices.data.map(inv => inv.id),
      invoiceStatuses: invoices.data.map(inv => ({ id: inv.id, status: inv.status }))
    });

    // Get total count by fetching first page without limit to count
    const totalCountResult = await stripeService.getCustomerInvoices(user.stripe_customer_id, {
      limit: 100, // Get a large batch to count
    });
    
    // Note: This is a simplified count. For production with many invoices, 
    // you'd want to implement a more efficient counting mechanism
    let totalCount = totalCountResult.data.length;
    let hasMoreToCount = totalCountResult.has_more;
    while (hasMoreToCount && totalCount < 1000) { // Limit to prevent infinite loop
      const nextBatch = await stripeService.getCustomerInvoices(user.stripe_customer_id, {
        limit: 100,
        starting_after: totalCountResult.data[totalCountResult.data.length - 1]?.id,
      });
      totalCount += nextBatch.data.length;
      hasMoreToCount = nextBatch.has_more;
      if (nextBatch.data.length === 0) break;
    }

    const totalPages = Math.ceil(totalCount / perPage);
    const hasNext = invoices.has_more || page < totalPages;
    const hasPrevious = page > 1;

    // Transform Stripe invoices to our API format
    const billingData = invoices.data.map((invoice: any) => {
      logger.info('Processing invoice', {
        id: invoice.id,
        status: invoice.status,
        amount_paid: invoice.amount_paid,
        amount_due: invoice.amount_due,
        hosted_invoice_url: invoice.hosted_invoice_url,
        invoice_pdf: invoice.invoice_pdf,
        number: invoice.number
      });

      return {
        id: invoice.id,
        date: new Date(invoice.created * 1000).toISOString(),
        amount: invoice.amount_paid || invoice.amount_due, // Use amount_due if not paid yet
        currency: invoice.currency,
        status: invoice.status as 'paid' | 'open' | 'draft' | 'void',
        description: invoice.description || `Invoice ${invoice.number || invoice.id}`,
        invoice_url: invoice.hosted_invoice_url,
        pdf_url: invoice.invoice_pdf,
      };
    });

    logger.info('Billing history retrieved', {
      userId: payload.userId,
      customerId: user.stripe_customer_id,
      page,
      perPage,
      invoiceCount: billingData.length,
      totalCount,
    });

    return c.json({
      data: billingData,
      pagination: {
        page,
        per_page: perPage,
        total_pages: totalPages,
        total_count: totalCount,
        has_next: hasNext,
        has_previous: hasPrevious,
      },
    });

  } catch (error) {
    logger.error('Billing history retrieval failed', { error });
    return c.json({ error: 'Failed to retrieve billing history' }, 500);
  }
});

// Payment info endpoint
const paymentInfoRoute = createRoute({
  method: 'get',
  path: '/billing/payment-info',
  summary: 'Get payment method and subscription info',
  description: 'Retrieve current payment method, subscription status, and billing portal URL',
  tags: ['Billing'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Payment info retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            payment_method: z.object({
              type: z.string(),
              last4: z.string(),
              brand: z.string(),
              exp_month: z.number(),
              exp_year: z.number(),
            }).nullable(),
            manage_payment_url: z.string(),
            next_billing_date: z.string().nullable(),
            subscription_status: z.string(),
            current_plan: z.object({
              name: z.string(),
              price: z.number(),
              currency: z.string(),
              interval: z.enum(['month', 'year']),
              description: z.string().optional(),
            }).optional(),
            manage_subscription_url: z.string().optional(),
            cancel_at: z.string().nullable(),
            canceled_at: z.string().nullable(),
            platform: z.enum(['stripe', 'apple', 'google']).optional(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
    },
    404: {
      description: 'User not found',
    },
    500: {
      description: 'Internal server error',
    },
  },
});

app.openapi(paymentInfoRoute, async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);
  let payload;

  try {
    payload = await authService.verifyToken(token);
    const user = await authService.getUserById(payload.userId);
    
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Get subscription from database to check platform
    const subscriptionRows = await query(
      `SELECT * FROM subscriptions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.organization_id]
    );
    const dbSubscription = subscriptionRows[0];
    const platform: SubscriptionPlatform = dbSubscription?.platform || 'stripe';

    // Check if user ever had a Stripe subscription (for trial eligibility)
    // Users who previously had Stripe sub are not eligible for trial/discount
    // Check via Stripe API if user has any subscription history
    let hadStripeSubscription = false;
    if (user.stripe_customer_id) {
      const allSubscriptions = await stripe.subscriptions.list({
        customer: user.stripe_customer_id,
        status: 'all',
        limit: 1,
      });
      hadStripeSubscription = allSubscriptions.data.length > 0;
    }
    const trialEligible = !hadStripeSubscription;

    logger.info('Trial eligibility check', {
      userId: user.id,
      stripeCustomerId: user.stripe_customer_id,
      hadStripeSubscription,
      trialEligible,
    });

    // For Apple/Google subscriptions, return minimal info (managed in-app)
    if (platform === 'apple' || platform === 'google') {
      logger.info('User has mobile subscription, returning platform-specific info', {
        userId: user.id,
        platform,
      });
      return c.json({
        payment_method: null,
        manage_payment_url: null,
        next_billing_date: dbSubscription?.current_period_end?.toISOString() || null,
        subscription_status: dbSubscription?.status || 'none',
        current_plan: dbSubscription?.tier === 'pro' ? {
          name: 'Pro Plan',
          price: 2999, // $29.99 in cents
          currency: 'usd',
          interval: 'month' as const,
          description: 'Managed via ' + (platform === 'apple' ? 'App Store' : 'Google Play'),
        } : null,
        manage_subscription_url: null,
        cancel_at: dbSubscription?.cancel_at?.toISOString() || null,
        canceled_at: dbSubscription?.canceled_at?.toISOString() || null,
        platform,
        trial_eligible: trialEligible,
        had_stripe_subscription: hadStripeSubscription,
      });
    }

    // If no Stripe customer, return empty/default data instead of error
    if (!user.stripe_customer_id) {
      logger.info('User has no stripe_customer_id, returning default payment info', {
        userId: user.id,
        email: user.email
      });
      return c.json({
        payment_method: null,
        manage_payment_url: null,
        next_billing_date: null,
        subscription_status: 'none',
        current_plan: null,
        manage_subscription_url: null,
        cancel_at: null,
        canceled_at: null,
        platform: 'stripe' as SubscriptionPlatform,
        trial_eligible: trialEligible,
        had_stripe_subscription: hadStripeSubscription,
      });
    }

    // Run all independent API calls in parallel for optimal performance
    const [
      paymentMethodsResult,
      subscriptionsResult,
      portalConfigs
    ] = await Promise.all([
      stripe.paymentMethods.list({ customer: user.stripe_customer_id, type: 'card', limit: 1 }),
      stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'all', limit: 10, expand: ['data.discounts'] }),
      getOrCreatePortalConfigs()
    ]);

    // Process payment method
    let paymentMethod = null;
    if (paymentMethodsResult.data.length > 0) {
      const pm = paymentMethodsResult.data[0];
      if (pm.card) {
        paymentMethod = {
          type: pm.type,
          last4: pm.card.last4,
          brand: pm.card.brand,
          exp_month: pm.card.exp_month,
          exp_year: pm.card.exp_year,
        };
      }
    }

    let subscriptionStatus = 'none';
    let nextBillingDate = null;
    let currentPlan = null;
    let cancelAt: string | null = null;
    let canceledAt: string | null = null;
    let trialEnd: string | null = null;
    let upcomingInvoiceAmount: number | null = null;

    // Process subscription - only consider active or trialing as having a valid plan
    const activeSubscription = subscriptionsResult.data.find(s => s.status === 'active' || s.status === 'trialing');
    const anySubscription = subscriptionsResult.data[0]; // For showing canceled/expired info

    // Check if we have a truly active subscription
    const now = Math.floor(Date.now() / 1000);

    if (activeSubscription) {
      subscriptionStatus = activeSubscription.status;

      // Get billing dates
      const subscriptionItem = activeSubscription.items?.data?.[0];
      if (subscriptionItem?.current_period_end) {
        nextBillingDate = new Date(subscriptionItem.current_period_end * 1000).toISOString();

        // Double-check: if period has ended but status is still 'active', it might be stale
        if (subscriptionItem.current_period_end < now && activeSubscription.status === 'active') {
          logger.warn('Subscription appears expired but status is active, may need webhook sync', {
            userId: user.id,
            subscriptionId: activeSubscription.id,
            periodEnd: subscriptionItem.current_period_end,
            now,
          });
        }
      }

      if (activeSubscription.cancel_at) {
        cancelAt = new Date(activeSubscription.cancel_at * 1000).toISOString();
      }

      if (activeSubscription.canceled_at) {
        canceledAt = new Date(activeSubscription.canceled_at * 1000).toISOString();
      }

      if (activeSubscription.trial_end) {
        trialEnd = new Date(activeSubscription.trial_end * 1000).toISOString();
      }

      // Process discounts - already expanded
      const discounts = (activeSubscription as any).discounts;
      if (discounts && discounts.length > 0 && typeof discounts[0] === 'object') {
        const couponId = discounts[0].coupon || discounts[0].source?.coupon;
        if (couponId) {
          try {
            const coupon = await stripe.coupons.retrieve(couponId);
            const basePrice = subscriptionItem?.price?.unit_amount || 0;

            if (coupon.amount_off) {
              upcomingInvoiceAmount = basePrice - coupon.amount_off;
            } else if (coupon.percent_off) {
              upcomingInvoiceAmount = Math.round(basePrice * (1 - coupon.percent_off / 100));
            }
          } catch (e) {
            // Coupon fetch failed, continue without discount info
          }
        }
      }

      // Get plan details for active subscription
      if (subscriptionItem?.price) {
        const price = subscriptionItem.price;
        let planName = 'Pro Plan'; // Default to Pro for unknown prices
        let planDescription = '';

        if (price.id === config.stripe.proPriceId) {
          planName = 'Pro Plan';
          planDescription = 'Perfect for growing businesses';
        } else if (price.id === config.stripe.enterprisePriceId) {
          planName = 'Enterprise Plan';
          planDescription = 'For large-scale operations';
        }

        currentPlan = {
          name: planName,
          price: price.unit_amount || 0,
          currency: price.currency,
          interval: price.recurring?.interval || 'month',
          description: planDescription
        };
      }
    } else if (anySubscription) {
      // No active subscription, but there's a canceled/expired one
      subscriptionStatus = anySubscription.status; // Will be 'canceled', 'past_due', etc.

      if (anySubscription.canceled_at) {
        canceledAt = new Date(anySubscription.canceled_at * 1000).toISOString();
      }

      // Check if local DB needs to be synced (edge case: webhook missed)
      if (dbSubscription && dbSubscription.status === 'active') {
        logger.info('Local DB shows active but Stripe shows no active subscription, syncing...', {
          userId: user.id,
          dbStatus: dbSubscription.status,
          stripeStatus: anySubscription.status,
        });

        // Update local DB to reflect expired/canceled status
        try {
          await query(
            `UPDATE subscriptions SET status = $1, canceled_at = $2, updated_at = NOW() WHERE organization_id = $3`,
            [anySubscription.status, anySubscription.canceled_at ? new Date(anySubscription.canceled_at * 1000) : null, user.organization_id]
          );
          logger.info('Synced subscription status from Stripe to local DB', {
            userId: user.id,
            newStatus: anySubscription.status,
          });
        } catch (syncError) {
          logger.error('Failed to sync subscription status to DB', { error: syncError });
        }
      }

      // Don't show plan details for canceled/expired subscriptions
      currentPlan = null;
    }

    const returnUrl = config.email.dashboardUrl || config.email.siteUrl || 'https://portal.lumapos.co';

    // Create portal sessions in parallel
    const [paymentPortalSession, subscriptionPortalSession] = await Promise.all([
      stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        configuration: portalConfigs.paymentConfigId,
        return_url: `${returnUrl}/billing`,
      }),
      stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        configuration: portalConfigs.subscriptionConfigId,
        return_url: `${returnUrl}/billing`,
      })
    ]);

    logger.info('Payment info retrieved', {
      userId: user.id,
      hasPaymentMethod: !!paymentMethod,
      subscriptionStatus,
      nextBillingDate,
      cancelAt,
      canceledAt,
    });

    return c.json({
      payment_method: paymentMethod,
      manage_payment_url: paymentPortalSession.url,
      next_billing_date: nextBillingDate,
      subscription_status: subscriptionStatus,
      current_plan: currentPlan,
      manage_subscription_url: subscriptionPortalSession.url,
      cancel_at: cancelAt,
      canceled_at: canceledAt,
      trial_end: trialEnd,
      upcoming_invoice_amount: upcomingInvoiceAmount,
      platform: 'stripe' as SubscriptionPlatform,
      trial_eligible: trialEligible,
      had_stripe_subscription: hadStripeSubscription,
    });

  } catch (error: any) {
    logger.error('Payment info retrieval failed', {
      error: {
        message: error?.message,
        name: error?.name,
        code: error?.code,
        type: error?.type,
        stack: error?.stack
      },
      userId: payload?.userId
    });
    return c.json({ error: 'Failed to retrieve payment info' }, 500);
  }
});

// Subscription info endpoint (for mobile app)
const subscriptionInfoRoute = createRoute({
  method: 'get',
  path: '/billing/subscription-info',
  summary: 'Get subscription info for mobile app',
  description: 'Retrieve subscription status, tier, and platform for the authenticated user (used by mobile app)',
  tags: ['Billing'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Subscription info retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            tier: z.enum(['starter', 'pro', 'enterprise', 'none']),
            status: z.enum(['active', 'past_due', 'canceled', 'trialing', 'none']),
            platform: z.enum(['stripe', 'apple', 'google']),
            current_plan: z.object({
              name: z.string(),
              price: z.number(),
              currency: z.string(),
              interval: z.enum(['month', 'year']),
              description: z.string().optional(),
            }).nullable(),
            current_period_end: z.string().nullable(),
            cancel_at: z.string().nullable(),
            canceled_at: z.string().nullable(),
            trial_end: z.string().nullable(),
            manage_subscription_url: z.string().nullable(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    404: { description: 'User not found' },
    500: { description: 'Internal server error' },
  },
});

app.openapi(subscriptionInfoRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const user = await authService.getUserById(payload.userId);

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Get subscription from database
    const subscriptionRows = await query(
      `SELECT * FROM subscriptions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.organization_id]
    );
    let dbSubscription = subscriptionRows[0];

    // Default response for no subscription
    if (!dbSubscription) {
      return c.json({
        tier: 'starter' as const,
        status: 'none' as const,
        platform: 'stripe' as SubscriptionPlatform,
        current_plan: null,
        current_period_end: null,
        cancel_at: null,
        canceled_at: null,
        trial_end: null,
        manage_subscription_url: null,
      });
    }

    const platform: SubscriptionPlatform = dbSubscription.platform || 'stripe';
    let manageSubscriptionUrl: string | null = null;

    // Edge case: Check if subscription appears expired but DB shows active
    // This can happen if webhooks failed to update our DB
    const now = new Date();
    const periodEnd = dbSubscription.current_period_end ? new Date(dbSubscription.current_period_end) : null;
    const isExpiredInDb = periodEnd && periodEnd < now && dbSubscription.status === 'active';

    if (isExpiredInDb && platform === 'stripe' && user.stripe_customer_id) {
      logger.info('DB subscription appears expired, checking Stripe for actual status', {
        userId: user.id,
        dbStatus: dbSubscription.status,
        periodEnd: periodEnd?.toISOString(),
      });

      try {
        // Check Stripe for the actual subscription status
        const stripeSubscriptions = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: 'all',
          limit: 1,
        });

        const stripeSub = stripeSubscriptions.data[0];
        if (stripeSub && stripeSub.status !== 'active' && stripeSub.status !== 'trialing') {
          // Stripe confirms subscription is not active - sync our DB
          logger.info('Stripe confirms subscription expired, syncing DB', {
            userId: user.id,
            stripeStatus: stripeSub.status,
          });

          await query(
            `UPDATE subscriptions SET status = $1, tier = 'starter', canceled_at = $2, updated_at = NOW() WHERE organization_id = $3`,
            [stripeSub.status, stripeSub.canceled_at ? new Date(stripeSub.canceled_at * 1000) : null, user.organization_id]
          );

          // Update local variable to reflect the change
          dbSubscription = {
            ...dbSubscription,
            status: stripeSub.status,
            tier: 'starter',
            canceled_at: stripeSub.canceled_at ? new Date(stripeSub.canceled_at * 1000) : null,
          };
        }
      } catch (e) {
        logger.warn('Failed to verify subscription with Stripe', { error: e });
      }
    }

    // For Stripe subscriptions with active status, generate a billing portal URL
    if (platform === 'stripe' && user.stripe_customer_id && dbSubscription.status === 'active') {
      try {
        const portalConfigs = await getOrCreatePortalConfigs();
        const returnUrl = config.email.dashboardUrl || 'https://portal.lumapos.co';
        const session = await stripe.billingPortal.sessions.create({
          customer: user.stripe_customer_id,
          configuration: portalConfigs.subscriptionConfigId,
          return_url: `${returnUrl}/billing`,
        });
        manageSubscriptionUrl = session.url;
      } catch (e) {
        logger.warn('Failed to create billing portal session', { error: e });
      }
    }

    // Build plan info based on tier - only show plan for active/trialing subscriptions
    let currentPlan = null;
    const isActiveSubscription = dbSubscription.status === 'active' || dbSubscription.status === 'trialing';

    if (isActiveSubscription && dbSubscription.tier === 'pro') {
      currentPlan = {
        name: 'Pro Plan',
        price: platform === 'stripe' ? 1900 : 2999, // $19 Stripe, $29.99 mobile
        currency: 'usd',
        interval: 'month' as const,
        description: platform === 'apple'
          ? 'Managed via App Store'
          : platform === 'google'
            ? 'Managed via Google Play'
            : 'Unlimited features for your business',
      };
    } else if (isActiveSubscription && dbSubscription.tier === 'enterprise') {
      currentPlan = {
        name: 'Enterprise Plan',
        price: dbSubscription.monthly_price || 29900,
        currency: 'usd',
        interval: 'month' as const,
        description: 'Custom enterprise solution',
      };
    }

    logger.info('Subscription info retrieved for mobile app', {
      userId: user.id,
      tier: dbSubscription.tier,
      platform,
      status: dbSubscription.status,
      isActive: isActiveSubscription,
    });

    return c.json({
      tier: dbSubscription.tier as 'starter' | 'pro' | 'enterprise',
      status: dbSubscription.status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'none',
      platform,
      current_plan: currentPlan,
      current_period_end: dbSubscription.current_period_end?.toISOString() || null,
      cancel_at: dbSubscription.cancel_at?.toISOString() || null,
      canceled_at: dbSubscription.canceled_at?.toISOString() || null,
      trial_end: dbSubscription.trial_end?.toISOString() || null,
      manage_subscription_url: manageSubscriptionUrl,
    });

  } catch (error: any) {
    logger.error('Subscription info retrieval failed', { error });
    return c.json({ error: 'Failed to retrieve subscription info' }, 500);
  }
});

// Get Stripe config (publishable key) - public endpoint
const stripeConfigRoute = createRoute({
  method: 'get',
  path: '/stripe/config',
  summary: 'Get Stripe publishable key',
  description: 'Returns the Stripe publishable key for client-side initialization',
  tags: ['Stripe'],
  responses: {
    200: {
      description: 'Stripe config retrieved successfully',
      content: {
        'application/json': {
          schema: z.object({
            publishableKey: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(stripeConfigRoute, async (c) => {
  return c.json({
    publishableKey: config.stripe.publishableKey,
  });
});

// Create checkout session for upgrading to Pro
const createUpgradeSessionRoute = createRoute({
  method: 'post',
  path: '/billing/create-upgrade-session',
  summary: 'Create checkout session for Pro upgrade',
  description: 'Creates a Stripe Checkout session for upgrading to Pro plan',
  tags: ['Billing'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Checkout session created',
      content: {
        'application/json': {
          schema: z.object({
            url: z.string(),
          }),
        },
      },
    },
    401: { description: 'Unauthorized' },
    400: { description: 'Already subscribed or missing configuration' },
    500: { description: 'Internal server error' },
  },
});

app.openapi(createUpgradeSessionRoute, async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = await authService.verifyToken(token);
    const user = await authService.getUserById(payload.userId);

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    if (!config.stripe.proPriceId) {
      logger.error('Pro price ID not configured');
      return c.json({ error: 'Pro plan not configured' }, 400);
    }

    // Ensure user has a Stripe customer ID
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      // Create a Stripe customer
      const customer = await stripe.customers.create({
        email: user.email,
        name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || undefined,
        metadata: {
          userId: user.id,
          organizationId: user.organization_id,
        },
      });
      customerId = customer.id;

      // Update user with Stripe customer ID
      const { query } = await import('../db');
      await query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, user.id]
      );

      logger.info('Created Stripe customer for user', {
        userId: user.id,
        customerId,
      });
    }

    // Check if user already has an active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length > 0) {
      return c.json({ error: 'Already have an active subscription' }, 400);
    }

    const returnUrl = config.email.dashboardUrl || 'https://portal.lumapos.co';

    // Create checkout session
    const session = await stripeService.createCheckoutSession({
      customer: customerId,
      price: config.stripe.proPriceId,
      successUrl: `${returnUrl}/billing?upgrade=success`,
      cancelUrl: `${returnUrl}/billing?upgrade=cancelled`,
      metadata: {
        userId: user.id,
        organizationId: user.organization_id,
        email: user.email,
      },
      mode: 'subscription',
    });

    logger.info('Upgrade checkout session created', {
      userId: user.id,
      sessionId: session.id,
    });

    return c.json({ url: session.url });
  } catch (error: any) {
    logger.error('Failed to create upgrade session', { error });
    return c.json({ error: 'Failed to create checkout session' }, 500);
  }
});

export { app as billingRoutes };