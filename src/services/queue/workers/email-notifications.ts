import { Job } from 'bullmq';
import { QueueName, JobData, queueService } from '../index';
import { logger } from '../../../utils/logger';
import { VendorBranding, sendOrderConfirmationEmail, sendReceiptEmail, sendPayoutEmail, sendWelcomeEmail, sendTicketConfirmationEmail, sendTicketReminderEmail, sendTicketRefundEmail, sendPreorderConfirmationEmail, sendPreorderReadyEmail, sendPreorderCancelledEmail, sendInvoiceEmail, sendInvoicePaidEmail, sendInvoicePaymentFailedEmail, sendInvoiceRefundedEmail } from '../../email/template-sender';

export function registerEmailNotifications() {
  return queueService.registerWorker(
    QueueName.EMAIL_NOTIFICATIONS,
    async (job: Job<JobData[QueueName.EMAIL_NOTIFICATIONS]>) => {
      const { type, to, data, vendorBranding: brandingData } = job.data;

      logger.info('Processing email notification', {
        type,
        to,
        jobId: job.id,
        hasVendorBranding: !!brandingData,
      });

      // Build VendorBranding if provided
      const vendorBranding: VendorBranding | undefined = brandingData
        ? { organizationName: brandingData.organizationName, brandingLogoUrl: brandingData.brandingLogoUrl }
        : undefined;

      try {
        switch (type) {
          // Internal emails (no vendor branding)
          case 'welcome':
            await sendWelcomeEmail(to, data as { firstName: string; organizationName: string; subscriptionTier: string });
            break;

          case 'payout_confirmation':
            await sendPayoutConfirmation(to, data);
            break;

          // Customer-facing emails (with vendor branding)
          case 'order_confirmation':
            await sendOrderConfirmationEmail(to, data as any, vendorBranding);
            break;

          case 'receipt':
            await sendReceiptEmail(to, data as any, vendorBranding);
            break;

          case 'ticket_confirmation':
            await sendTicketConfirmationEmail(to, data as any, vendorBranding);
            break;

          case 'ticket_reminder':
            await sendTicketReminderEmail(to, data as any, vendorBranding);
            break;

          case 'ticket_refund':
            await sendTicketRefundEmail(to, data as any, vendorBranding);
            break;

          case 'preorder_confirmation':
            await sendPreorderConfirmationEmail(to, data as any, vendorBranding);
            break;

          case 'preorder_ready':
            await sendPreorderReadyEmail(to, data as any, vendorBranding);
            break;

          case 'preorder_cancelled':
            await sendPreorderCancelledEmail(to, data as any, vendorBranding);
            break;

          case 'invoice_sent':
            await sendInvoiceEmail(to, data as any, vendorBranding);
            break;

          case 'invoice_paid':
            await sendInvoicePaidEmail(to, data as any, vendorBranding);
            break;

          case 'invoice_payment_failed':
            await sendInvoicePaymentFailedEmail(to, data as any, vendorBranding);
            break;

          case 'invoice_refunded':
            await sendInvoiceRefundedEmail(to, data as any, vendorBranding);
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

async function sendPayoutConfirmation(to: string, data: Record<string, any>) {
  await sendPayoutEmail(to, data);
}
