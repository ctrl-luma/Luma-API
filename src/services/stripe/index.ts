import Stripe from 'stripe';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2025-10-29.clover',
  typescript: true,
});

export interface CreatePaymentIntentParams {
  amount: number;
  currency?: string;
  customer?: string;
  description?: string;
  metadata?: Record<string, string>;
  transfer_data?: {
    destination: string;
    amount?: number;
  };
}

export interface CreateConnectedAccountParams {
  type?: 'express' | 'standard' | 'custom';
  country?: string;
  email: string;
  business_type?: 'individual' | 'company';
  capabilities?: {
    card_payments?: { requested: boolean };
    transfers?: { requested: boolean };
  };
  metadata?: Record<string, string>;
}

export class StripeService {
  async createPaymentIntent(params: CreatePaymentIntentParams) {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(params.amount * 100),
        currency: params.currency || 'usd',
        customer: params.customer,
        description: params.description,
        metadata: params.metadata,
        transfer_data: params.transfer_data,
        automatic_payment_methods: {
          enabled: true,
        },
      });

      logger.info('Payment intent created', {
        paymentIntentId: paymentIntent.id,
        amount: params.amount,
      });

      return paymentIntent;
    } catch (error) {
      logger.error('Failed to create payment intent', error);
      throw error;
    }
  }

  async confirmPaymentIntent(paymentIntentId: string, paymentMethodId?: string) {
    try {
      const paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId, {
        payment_method: paymentMethodId,
      });

      logger.info('Payment intent confirmed', {
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status,
      });

      return paymentIntent;
    } catch (error) {
      logger.error('Failed to confirm payment intent', error);
      throw error;
    }
  }

  async createRefund(chargeId: string, amount?: number, reason?: string) {
    try {
      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: amount ? Math.round(amount * 100) : undefined,
        reason: reason as Stripe.RefundCreateParams.Reason,
      });

      logger.info('Refund created', {
        refundId: refund.id,
        chargeId,
        amount: refund.amount / 100,
      });

      return refund;
    } catch (error) {
      logger.error('Failed to create refund', error);
      throw error;
    }
  }

  async createConnectedAccount(params: CreateConnectedAccountParams) {
    try {
      const account = await stripe.accounts.create({
        type: params.type || 'express',
        country: params.country || 'US',
        email: params.email,
        business_type: params.business_type,
        capabilities: params.capabilities || {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: params.metadata,
      });

      logger.info('Connected account created', {
        accountId: account.id,
        email: params.email,
      });

      return account;
    } catch (error) {
      logger.error('Failed to create connected account', error);
      throw error;
    }
  }

  async createAccountLink(accountId: string, refreshUrl: string, returnUrl: string) {
    try {
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });

      logger.info('Account link created', { accountId });

      return accountLink;
    } catch (error) {
      logger.error('Failed to create account link', error);
      throw error;
    }
  }

  async retrieveAccount(accountId: string) {
    try {
      const account = await stripe.accounts.retrieve(accountId);
      return account;
    } catch (error) {
      logger.error('Failed to retrieve account', error);
      throw error;
    }
  }

  async createCheckoutSession(params: {
    customer: string;
    price?: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    mode?: 'payment' | 'subscription';
  }) {
    try {
      const session = await stripe.checkout.sessions.create({
        customer: params.customer,
        line_items: params.price ? [
          {
            price: params.price,
            quantity: 1,
          },
        ] : undefined,
        mode: params.mode || 'subscription',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: params.metadata,
        allow_promotion_codes: true,
        billing_address_collection: 'required',
      });
      
      logger.info('Checkout session created', { 
        sessionId: session.id,
        customer: params.customer 
      });
      
      return session;
    } catch (error) {
      logger.error('Failed to create checkout session', error);
      throw error;
    }
  }

  async createTransfer(params: {
    amount: number;
    currency?: string;
    destination: string;
    description?: string;
    metadata?: Record<string, string>;
  }) {
    try {
      const transfer = await stripe.transfers.create({
        amount: Math.round(params.amount * 100),
        currency: params.currency || 'usd',
        destination: params.destination,
        description: params.description,
        metadata: params.metadata,
      });

      logger.info('Transfer created', {
        transferId: transfer.id,
        amount: params.amount,
        destination: params.destination,
      });

      return transfer;
    } catch (error) {
      logger.error('Failed to create transfer', error);
      throw error;
    }
  }

  async createPayout(params: {
    amount: number;
    currency?: string;
    destination?: string;
    description?: string;
    metadata?: Record<string, string>;
    stripeAccount?: string;
  }) {
    try {
      const payout = await stripe.payouts.create({
        amount: Math.round(params.amount * 100),
        currency: params.currency || 'usd',
        destination: params.destination,
        description: params.description,
        metadata: params.metadata,
      }, {
        stripeAccount: params.stripeAccount,
      });

      logger.info('Payout created', {
        payoutId: payout.id,
        amount: params.amount,
      });

      return payout;
    } catch (error) {
      logger.error('Failed to create payout', error);
      throw error;
    }
  }

  async createCustomer(params: {
    email?: string;
    phone?: string;
    name?: string;
    description?: string;
    metadata?: Record<string, string>;
  }) {
    try {
      const customer = await stripe.customers.create(params);

      logger.info('Customer created', {
        customerId: customer.id,
        email: customer.email,
      });

      return customer;
    } catch (error) {
      logger.error('Failed to create customer', error);
      throw error;
    }
  }

  async attachPaymentMethod(paymentMethodId: string, customerId: string) {
    try {
      const paymentMethod = await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });

      logger.info('Payment method attached', {
        paymentMethodId,
        customerId,
      });

      return paymentMethod;
    } catch (error) {
      logger.error('Failed to attach payment method', error);
      throw error;
    }
  }

  constructWebhookEvent(payload: string | Buffer, signature: string, secret: string) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (error) {
      logger.error('Failed to construct webhook event', error);
      throw error;
    }
  }

  async createSubscription(params: {
    customer: string;
    items: Array<{ price: string; quantity?: number }>;
    payment_behavior?: 'default_incomplete' | 'error_if_incomplete' | 'allow_incomplete' | 'pending_if_incomplete';
    expand?: string[];
    metadata?: Record<string, string>;
    trial_period_days?: number;
  }) {
    try {
      const subscription = await stripe.subscriptions.create({
        customer: params.customer,
        items: params.items,
        payment_behavior: params.payment_behavior || 'default_incomplete',
        expand: params.expand || ['latest_invoice.payment_intent', 'pending_setup_intent'],
        metadata: params.metadata,
        trial_period_days: params.trial_period_days,
        payment_settings: {
          save_default_payment_method: 'on_subscription',
          payment_method_types: ['card'],
        },
        // This ensures the invoice is finalized and payment intent is created
        collection_method: 'charge_automatically',
      });

      logger.info('Subscription created', {
        subscriptionId: subscription.id,
        customer: params.customer,
        status: subscription.status,
        hasLatestInvoice: !!subscription.latest_invoice,
        latestInvoiceType: typeof subscription.latest_invoice,
        hasPaymentIntent: subscription.latest_invoice && 
          typeof subscription.latest_invoice !== 'string' && 
          !!(subscription.latest_invoice as any).payment_intent,
        hasPendingSetupIntent: !!subscription.pending_setup_intent,
        pendingSetupIntentType: typeof subscription.pending_setup_intent,
      });

      // Log the actual structure
      if (subscription.latest_invoice && typeof subscription.latest_invoice !== 'string') {
        const invoice = subscription.latest_invoice as any;
        logger.info('Latest invoice details', {
          invoiceId: invoice.id,
          status: invoice.status,
          payment_intent: invoice.payment_intent,
          hasPaymentIntent: !!invoice.payment_intent,
        });
      }

      // Log pending_setup_intent details
      logger.info('Pending setup intent details', {
        pending_setup_intent: subscription.pending_setup_intent,
        pending_setup_intent_type: typeof subscription.pending_setup_intent,
        is_string: typeof subscription.pending_setup_intent === 'string',
      });

      return subscription;
    } catch (error) {
      logger.error('Failed to create subscription', error);
      throw error;
    }
  }

  async getSubscriptionPaymentIntent(subscriptionId: string): Promise<string | null> {
    try {
      // First retrieve the subscription
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['latest_invoice']
      });

      if (!subscription.latest_invoice || typeof subscription.latest_invoice === 'string') {
        logger.error('No latest invoice found for subscription', { subscriptionId });
        return null;
      }

      // Get the full invoice object
      const invoice = await stripe.invoices.retrieve(subscription.latest_invoice.id, {
        expand: ['payment_intent']
      }) as any; // Type assertion for expanded properties

      logger.info('Retrieved invoice', {
        invoiceId: invoice.id,
        status: invoice.status,
        hasPaymentIntent: !!invoice.payment_intent,
        paymentIntentType: typeof invoice.payment_intent
      });

      // Check if invoice already has a payment intent
      if (invoice.payment_intent && 
          typeof invoice.payment_intent !== 'string' &&
          invoice.payment_intent.client_secret) {
        return invoice.payment_intent.client_secret;
      }

      // If no payment intent exists, we need to create one
      if (!invoice.payment_intent && (invoice.status === 'open' || invoice.status === 'draft')) {
        logger.info('Creating payment intent for invoice', { 
          invoiceId: invoice.id,
          status: invoice.status 
        });

        // For open invoices, we need to create a payment intent
        if (invoice.status === 'open') {
          // Retrieve the payment intent from the invoice
          const updatedInvoice = await stripe.invoices.retrieve(invoice.id) as any;
          
          // If still no payment intent, the subscription might need different handling
          logger.info('Invoice details after retrieval', {
            invoiceId: updatedInvoice.id,
            hasPaymentIntent: !!updatedInvoice.payment_intent,
            amountDue: updatedInvoice.amount_due,
            amountPaid: updatedInvoice.amount_paid,
            attemptCount: updatedInvoice.attempt_count
          });

          // Get the subscription's payment method collection status
          const paymentIntent = await stripe.paymentIntents.create({
            amount: updatedInvoice.amount_due,
            currency: updatedInvoice.currency,
            customer: updatedInvoice.customer as string,
            metadata: {
              invoice_id: updatedInvoice.id,
              subscription_id: subscriptionId
            },
            setup_future_usage: 'off_session',
            automatic_payment_methods: {
              enabled: true
            }
          });

          return paymentIntent.client_secret;
        } else {
          // For draft invoices, finalize first
          const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id, {
            expand: ['payment_intent']
          }) as any;
          
          if (finalizedInvoice.payment_intent && 
              typeof finalizedInvoice.payment_intent !== 'string' &&
              finalizedInvoice.payment_intent.client_secret) {
            return finalizedInvoice.payment_intent.client_secret;
          }
        }
      }

      return null;
    } catch (error) {
      logger.error('Failed to get subscription payment intent', error);
      throw error;
    }
  }
}

export const stripeService = new StripeService();