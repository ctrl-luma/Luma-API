import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { authService } from '../services/auth';
import { stripeService, stripe } from '../services/stripe';
import { logger } from '../utils/logger';
import { config } from '../config';

const app = new OpenAPIHono();

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
      logger.info('User has no stripe_customer_id', { 
        userId: user.id,
        email: user.email 
      });
      return c.json({ error: 'No billing history found' }, 404);
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
    
    if (!user || !user.stripe_customer_id) {
      return c.json({ error: 'User not found' }, 404);
    }

    logger.info('Starting payment info retrieval', {
      userId: user.id,
      stripeCustomerId: user.stripe_customer_id
    });

    let paymentMethod = null;

    // Get payment methods attached to customer using proper Stripe API
    try {
      const paymentMethods = await stripe.paymentMethods.list({
        customer: user.stripe_customer_id,
        type: 'card',
        limit: 1,
      });

      logger.info('Payment methods retrieved', {
        customerId: user.stripe_customer_id,
        paymentMethodCount: paymentMethods.data.length
      });

      if (paymentMethods.data.length > 0) {
        const pm = paymentMethods.data[0];
        
        logger.info('Payment method found', {
          pmId: pm.id,
          type: pm.type,
          hasCard: !!pm.card
        });

        if (pm.card) {
          paymentMethod = {
            type: pm.type,
            last4: pm.card.last4,
            brand: pm.card.brand,
            exp_month: pm.card.exp_month,
            exp_year: pm.card.exp_year,
          };
        }
      } else {
        logger.info('No payment methods attached to customer');
      }
    } catch (pmError) {
      logger.error('Failed to retrieve customer payment methods', { error: pmError });
    }

    // Get all subscriptions for status and billing info
    const allSubscriptions = await stripe.subscriptions.list({
      customer: user.stripe_customer_id,
      status: 'all',
      limit: 10,
    });

    logger.info('All subscriptions retrieved', {
      subscriptionCount: allSubscriptions.data.length,
      subscriptions: allSubscriptions.data.map(s => ({
        id: s.id,
        status: s.status,
        cancel_at: s.cancel_at,
        canceled_at: s.canceled_at,
      }))
    });

    let subscriptionStatus = 'none';
    let nextBillingDate = null;
    let currentPlan = null;
    let cancelAt: string | null = null;
    let canceledAt: string | null = null;

    logger.info('Processing subscription data', {
      subscriptionCount: allSubscriptions.data.length,
      subscriptions: allSubscriptions.data.map(s => ({
        id: s.id,
        status: s.status,
        hasItems: !!s.items,
        itemsCount: s.items?.data?.length || 0
      }))
    });

    if (allSubscriptions.data.length > 0) {
      try {
        // Get the most recent active subscription, or any subscription if no active ones
        const subscriptionFromList = allSubscriptions.data.find(s => s.status === 'active') || allSubscriptions.data[0];

        // Retrieve the full subscription to get all fields including current_period_end
        const activeSubscription = await stripe.subscriptions.retrieve(subscriptionFromList.id);
        subscriptionStatus = activeSubscription.status;

        // Log the raw subscription object to see all available fields
        logger.info('Raw subscription object keys', {
          keys: Object.keys(activeSubscription),
          rawSubscription: JSON.stringify(activeSubscription)
        });

        logger.info('Active subscription found', {
          subscriptionId: activeSubscription.id,
          status: activeSubscription.status,
          cancel_at: activeSubscription.cancel_at,
          canceled_at: activeSubscription.canceled_at,
          cancel_at_period_end: activeSubscription.cancel_at_period_end,
          hasItems: !!activeSubscription.items
        });

        // In newer Stripe API versions, current_period_end is on the subscription item, not the subscription
        const subscriptionItem = activeSubscription.items?.data?.[0];
        if (subscriptionItem?.current_period_end) {
          nextBillingDate = new Date(subscriptionItem.current_period_end * 1000).toISOString();
          logger.info('Next billing date set', { nextBillingDate });
        }

        // Extract cancellation dates from subscription
        if (activeSubscription.cancel_at) {
          cancelAt = new Date(activeSubscription.cancel_at * 1000).toISOString();
          logger.info('Cancel at date set', { cancelAt });
        }

        if (activeSubscription.canceled_at) {
          canceledAt = new Date(activeSubscription.canceled_at * 1000).toISOString();
          logger.info('Canceled at date set', { canceledAt });
        }

        // Get plan details from subscription items
        if (activeSubscription.items?.data?.length > 0) {
          const priceItem = activeSubscription.items.data[0];
          const price = priceItem.price;
          
          logger.info('Processing price item', {
            priceId: price.id,
            unitAmount: price.unit_amount,
            currency: price.currency,
            interval: price.recurring?.interval
          });
          
          // Map price ID to plan details
          let planName = 'Custom Plan';
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
          
          logger.info('Current plan created', { currentPlan });
        } else {
          logger.info('No subscription items found');
        }
      } catch (subscriptionError) {
        logger.error('Error processing subscription data', { 
          error: subscriptionError,
          subscriptionId: allSubscriptions.data[0]?.id 
        });
      }
    } else {
      logger.info('No subscriptions found for customer');
    }

    // Create billing portal configuration for payment methods only
    logger.info('Creating payment portal configuration');
    const paymentOnlyConfig = await stripe.billingPortal.configurations.create({
      features: {
        payment_method_update: {
          enabled: true
        },
        invoice_history: {
          enabled: false
        },
        subscription_cancel: {
          enabled: false
        },
        customer_update: {
          enabled: false
        },
        subscription_update: {
          enabled: false
        }
      },
      business_profile: {
        headline: 'Manage your payment method'
      }
    });

    // Create billing portal configuration for subscription management  
    logger.info('Creating subscription portal configuration');
    const subscriptionConfig = await stripe.billingPortal.configurations.create({
      features: {
        payment_method_update: {
          enabled: false
        },
        invoice_history: {
          enabled: false
        },
        subscription_cancel: {
          enabled: true
        },
        customer_update: {
          enabled: false
        },
        subscription_update: {
          enabled: false
        }
      },
      business_profile: {
        headline: 'Manage your subscription'
      }
    });

    const returnUrl = config.email.dashboardUrl || config.email.siteUrl || 'https://portal.lumapos.co';

    // Create payment management portal session
    const paymentPortalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      configuration: paymentOnlyConfig.id,
      return_url: `${returnUrl}/billing`,
    });

    // Create subscription management portal session
    const subscriptionPortalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      configuration: subscriptionConfig.id,
      return_url: `${returnUrl}/billing`,
    });

    logger.info('Billing portal sessions created', {
      paymentSessionId: paymentPortalSession.id,
      subscriptionSessionId: subscriptionPortalSession.id
    });

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

export { app as billingRoutes };