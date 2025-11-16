import { Job } from 'bullmq';
import { QueueName, JobData, queueService } from '../index';
import { stripeService } from '../../stripe';
import { query, transaction } from '../../../db';
import { logger } from '../../../utils/logger';

export function registerPaymentProcessor() {
  return queueService.registerWorker(
    QueueName.PAYMENT_PROCESSING,
    async (job: Job<JobData[QueueName.PAYMENT_PROCESSING]>) => {
      const { orderId, paymentIntentId, amount } = job.data;

      logger.info('Processing payment job', {
        orderId,
        paymentIntentId,
        amount,
      });

      try {
        const paymentIntent = await stripeService.stripe.paymentIntents.retrieve(
          paymentIntentId
        );

        if (paymentIntent.status === 'succeeded') {
          await transaction(async (client) => {
            await client.query(
              `UPDATE orders 
               SET status = 'completed',
                   stripe_charge_id = $1,
                   updated_at = NOW()
               WHERE id = $2`,
              [paymentIntent.latest_charge, orderId]
            );

            const orderResult = await client.query(
              `SELECT o.*, e.organization_id, e.revenue_split
               FROM orders o
               JOIN events e ON o.event_id = e.id
               WHERE o.id = $1`,
              [orderId]
            );

            if (orderResult.rows.length > 0) {
              const order = orderResult.rows[0];
              
              if (order.revenue_split && Array.isArray(order.revenue_split)) {
                for (const split of order.revenue_split) {
                  if (split.stripe_account_id && split.percentage > 0) {
                    const splitAmount = (order.total_amount * split.percentage) / 100;
                    
                    await queueService.addJob(QueueName.PAYOUT_PROCESSING, {
                      eventId: order.event_id,
                      amount: splitAmount,
                      type: 'revenue_split',
                    });
                  }
                }
              }
            }
          });

          await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
            type: 'order_confirmation',
            to: paymentIntent.receipt_email || '',
            data: {
              orderId,
              amount,
              paymentIntentId,
            },
          });

          return { status: 'completed', orderId };
        } else {
          await query(
            `UPDATE orders 
             SET status = 'failed',
                 updated_at = NOW()
             WHERE id = $1`,
            [orderId]
          );

          return { status: 'failed', orderId, reason: paymentIntent.status };
        }
      } catch (error) {
        logger.error('Payment processing error', { orderId, error });
        throw error;
      }
    }
  );
}