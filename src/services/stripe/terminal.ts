import { stripe } from './index';
import { logger } from '../../utils/logger';
import { toSmallestUnit } from '../../utils/currency';
import Stripe from 'stripe';

export interface CreateTerminalReaderParams {
  registration_code: string;
  label: string;
  location: string;
  metadata?: Record<string, string>;
}

export interface ProcessTerminalPaymentParams {
  amount: number;
  currency?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export class StripeTerminalService {
  private opts(stripeAccount?: string): Stripe.RequestOptions {
    return stripeAccount ? { stripeAccount } : {};
  }

  async createLocation(params: {
    display_name: string;
    address: {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postal_code: string;
      country: string;
    };
    metadata?: Record<string, string>;
  }, stripeAccount?: string) {
    try {
      const location = await stripe.terminal.locations.create(params, this.opts(stripeAccount));

      logger.info('Terminal location created', {
        locationId: location.id,
        displayName: params.display_name,
      });

      return location;
    } catch (error) {
      logger.error('Failed to create terminal location', error);
      throw error;
    }
  }

  async createReader(params: CreateTerminalReaderParams, stripeAccount?: string) {
    try {
      const reader = await stripe.terminal.readers.create(params, this.opts(stripeAccount));

      logger.info('Terminal reader created', {
        readerId: reader.id,
        label: params.label,
      });

      return reader;
    } catch (error) {
      logger.error('Failed to create terminal reader', error);
      throw error;
    }
  }

  async listReaders(location?: string, status?: 'online' | 'offline', stripeAccount?: string) {
    try {
      const readers = await stripe.terminal.readers.list({
        location,
        status,
        limit: 100,
      }, this.opts(stripeAccount));

      return readers.data;
    } catch (error) {
      logger.error('Failed to list terminal readers', error);
      throw error;
    }
  }

  async deleteReader(readerId: string, stripeAccount?: string) {
    try {
      const result = await stripe.terminal.readers.del(readerId, this.opts(stripeAccount));

      logger.info('Terminal reader deleted', { readerId });

      return result;
    } catch (error) {
      logger.error('Failed to delete terminal reader', error);
      throw error;
    }
  }

  async createConnectionToken(location?: string, stripeAccount?: string) {
    try {
      const connectionToken = await stripe.terminal.connectionTokens.create({
        location,
      }, this.opts(stripeAccount));

      logger.info('Connection token created');

      return connectionToken;
    } catch (error) {
      logger.error('Failed to create connection token', error);
      throw error;
    }
  }

  async createPaymentIntent(params: ProcessTerminalPaymentParams, stripeAccount?: string) {
    try {
      const currency = params.currency || 'usd';
      const paymentIntent = await stripe.paymentIntents.create({
        amount: toSmallestUnit(params.amount, currency),
        currency,
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: params.description,
        metadata: params.metadata,
      }, this.opts(stripeAccount));

      logger.info('Terminal payment intent created', {
        paymentIntentId: paymentIntent.id,
        amount: params.amount,
      });

      return paymentIntent;
    } catch (error) {
      logger.error('Failed to create terminal payment intent', error);
      throw error;
    }
  }

  async capturePaymentIntent(paymentIntentId: string, stripeAccount?: string) {
    try {
      const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId, {}, this.opts(stripeAccount));

      logger.info('Terminal payment intent captured', {
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status,
      });

      return paymentIntent;
    } catch (error) {
      logger.error('Failed to capture terminal payment intent', error);
      throw error;
    }
  }

  async cancelPaymentIntent(paymentIntentId: string, stripeAccount?: string) {
    try {
      const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId, {}, this.opts(stripeAccount));

      logger.info('Terminal payment intent cancelled', {
        paymentIntentId: paymentIntent.id,
      });

      return paymentIntent;
    } catch (error) {
      logger.error('Failed to cancel terminal payment intent', error);
      throw error;
    }
  }

  async processPaymentOnReader(readerId: string, paymentIntentId: string, stripeAccount?: string) {
    try {
      const reader = await stripe.terminal.readers.processPaymentIntent(
        readerId,
        { payment_intent: paymentIntentId },
        this.opts(stripeAccount)
      );

      logger.info('Payment sent to terminal reader', {
        readerId,
        paymentIntentId,
        actionStatus: reader.action?.status,
      });

      return reader;
    } catch (error) {
      logger.error('Failed to process payment on reader', error);
      throw error;
    }
  }

  async cancelReaderAction(readerId: string, stripeAccount?: string) {
    try {
      const reader = await stripe.terminal.readers.cancelAction(readerId, this.opts(stripeAccount));

      logger.info('Terminal reader action cancelled', { readerId });

      return reader;
    } catch (error) {
      logger.error('Failed to cancel reader action', error);
      throw error;
    }
  }

  async simulateReaderAction(readerId: string, action: 'process_payment_intent', stripeAccount?: string) {
    try {
      const result = await stripe.testHelpers.terminal.readers.presentPaymentMethod(
        readerId,
        {},
        this.opts(stripeAccount)
      );

      logger.info('Simulated reader action', {
        readerId,
        action,
      });

      return result;
    } catch (error) {
      logger.error('Failed to simulate reader action', error);
      throw error;
    }
  }
}

export const stripeTerminalService = new StripeTerminalService();
