import { Job } from 'bullmq';
import { QueueName, JobData, queueService } from '../index';
import { logger } from '../../../utils/logger';

export function registerEmailNotifications() {
  return queueService.registerWorker(
    QueueName.EMAIL_NOTIFICATIONS,
    async (job: Job<JobData[QueueName.EMAIL_NOTIFICATIONS]>) => {
      const { type, to, data } = job.data;

      logger.info('Processing email notification', {
        type,
        to,
        jobId: job.id,
      });

      try {
        switch (type) {
          case 'order_confirmation':
            await sendOrderConfirmation(to, data);
            break;
          
          case 'receipt':
            await sendReceipt(to, data);
            break;
          
          case 'payout_confirmation':
            await sendPayoutConfirmation(to, data);
            break;
          
          default:
            throw new Error(`Unknown email type: ${type}`);
        }

        return { sent: true, to, type };
      } catch (error) {
        logger.error('Email notification error', { type, to, error });
        throw error;
      }
    }
  );
}

async function sendOrderConfirmation(to: string, data: Record<string, any>) {
  logger.info('Sending order confirmation email', { to, orderId: data.orderId });
}

async function sendReceipt(to: string, data: Record<string, any>) {
  logger.info('Sending receipt email', { to, orderId: data.orderId });
}

async function sendPayoutConfirmation(to: string, data: Record<string, any>) {
  logger.info('Sending payout confirmation email', { to, payoutId: data.payoutId });
}