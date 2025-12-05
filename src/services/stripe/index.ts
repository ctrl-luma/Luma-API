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
}

export const stripeService = new StripeService();