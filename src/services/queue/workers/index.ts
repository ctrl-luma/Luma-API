import { registerPaymentProcessor } from './payment-processor';
import { registerEmailNotifications } from './email-notifications';
import { registerPayoutProcessor } from './payout-processor';
import { logger } from '../../../utils/logger';

export function registerAllWorkers() {
  logger.info('Registering queue workers...');

  registerPaymentProcessor();
  registerEmailNotifications();
  registerPayoutProcessor();

  logger.info('All queue workers registered');
}