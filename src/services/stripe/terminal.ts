import { stripe } from './index';
import { logger } from '../../utils/logger';

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
  }) {
    try {
      const location = await stripe.terminal.locations.create(params);
      
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

  async createReader(params: CreateTerminalReaderParams) {
    try {
      const reader = await stripe.terminal.readers.create(params);
      
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

  async listReaders(location?: string, status?: 'online' | 'offline') {
    try {
      const readers = await stripe.terminal.readers.list({
        location,
        status,
        limit: 100,
      });

      return readers.data;
    } catch (error) {
      logger.error('Failed to list terminal readers', error);
      throw error;
    }
  }

  async createConnectionToken(location?: string) {
    try {
      const connectionToken = await stripe.terminal.connectionTokens.create({
        location,
      });
      
      logger.info('Connection token created');

      return connectionToken;
    } catch (error) {
      logger.error('Failed to create connection token', error);
      throw error;
    }
  }

  async createPaymentIntent(params: ProcessTerminalPaymentParams) {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(params.amount * 100),
        currency: params.currency || 'usd',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: params.description,
        metadata: params.metadata,
      });

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

  async capturePaymentIntent(paymentIntentId: string) {
    try {
      const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId);
      
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

  async cancelPaymentIntent(paymentIntentId: string) {
    try {
      const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId);
      
      logger.info('Terminal payment intent cancelled', {
        paymentIntentId: paymentIntent.id,
      });

      return paymentIntent;
    } catch (error) {
      logger.error('Failed to cancel terminal payment intent', error);
      throw error;
    }
  }

  async simulateReaderAction(readerId: string, action: 'process_payment_intent') {
    try {
      const result = await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
      
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