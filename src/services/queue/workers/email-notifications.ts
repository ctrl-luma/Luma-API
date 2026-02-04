import { Job } from 'bullmq';
import { QueueName, JobData, queueService } from '../index';
import { logger } from '../../../utils/logger';
import { sendOrderConfirmationEmail, sendReceiptEmail, sendPayoutEmail, sendWelcomeEmail, sendTicketConfirmationEmail, sendTicketReminderEmail, sendTicketRefundEmail } from '../../email/template-sender';

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
          case 'welcome':
            await sendWelcomeEmail(to, data as { firstName: string; organizationName: string; subscriptionTier: string });
            break;

          case 'order_confirmation':
            await sendOrderConfirmation(to, data);
            break;
          
          case 'receipt':
            await sendReceipt(to, data);
            break;
          
          case 'payout_confirmation':
            await sendPayoutConfirmation(to, data);
            break;

          case 'ticket_confirmation':
            await sendTicketConfirmationEmail(to, data as any);
            break;

          case 'ticket_reminder':
            await sendTicketReminderEmail(to, data as any);
            break;

          case 'ticket_refund':
            await sendTicketRefundEmail(to, data as any);
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
  await sendOrderConfirmationEmail(to, data);
}

async function sendReceipt(to: string, data: Record<string, any>) {
  await sendReceiptEmail(to, data);
}

async function sendPayoutConfirmation(to: string, data: Record<string, any>) {
  await sendPayoutEmail(to, data);
}