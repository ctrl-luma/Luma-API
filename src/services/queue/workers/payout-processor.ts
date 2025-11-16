import { Job } from 'bullmq';
import { QueueName, JobData, queueService } from '../index';
import { stripeService } from '../../stripe';
import { query, transaction } from '../../../db';
import { logger } from '../../../utils/logger';

export function registerPayoutProcessor() {
  return queueService.registerWorker(
    QueueName.PAYOUT_PROCESSING,
    async (job: Job<JobData[QueueName.PAYOUT_PROCESSING]>) => {
      const { eventId, userId, amount, type } = job.data;

      logger.info('Processing payout job', {
        eventId,
        userId,
        amount,
        type,
      });

      try {
        const eventResult = await query(
          `SELECT e.*, o.stripe_account_id 
           FROM events e
           JOIN organizations o ON e.organization_id = o.id
           WHERE e.id = $1`,
          [eventId]
        );

        if (eventResult.length === 0) {
          throw new Error('Event not found');
        }

        const event = eventResult[0];
        
        let destinationAccount: string | undefined;
        let description: string;

        if (type === 'revenue_split') {
          const revenueSplits = event.revenue_split || [];
          const split = revenueSplits.find((s: any) => s.stripe_account_id);
          
          if (!split) {
            logger.warn('No revenue split configuration found', { eventId });
            return { status: 'skipped', reason: 'No revenue split configured' };
          }

          destinationAccount = split.stripe_account_id;
          description = `Revenue split for ${event.name}`;
        } else if (type === 'tip_out' && userId) {
          const userResult = await query(
            `SELECT u.*, o.stripe_account_id as user_stripe_account
             FROM users u
             LEFT JOIN organizations o ON u.organization_id = o.id
             WHERE u.id = $1`,
            [userId]
          );

          if (userResult.length === 0) {
            throw new Error('User not found');
          }

          const user = userResult[0];
          destinationAccount = user.user_stripe_account;
          description = `Tip payout for ${user.first_name} ${user.last_name} - ${event.name}`;
        }

        if (!destinationAccount) {
          logger.warn('No destination account for payout', { eventId, userId, type });
          return { status: 'skipped', reason: 'No destination account' };
        }

        const transfer = await stripeService.createTransfer({
          amount,
          destination: destinationAccount,
          description,
          metadata: {
            event_id: eventId,
            type,
            ...(userId && { user_id: userId }),
          },
        });

        await transaction(async (client) => {
          const payoutResult = await client.query(
            `INSERT INTO payouts (
              organization_id, event_id, user_id, amount, 
              status, stripe_transfer_id, type, description
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id`,
            [
              event.organization_id,
              eventId,
              userId,
              amount,
              'processing',
              transfer.id,
              type,
              description,
            ]
          );

          const payoutId = payoutResult.rows[0].id;

          if (userId) {
            const userResult = await client.query(
              `SELECT email FROM users WHERE id = $1`,
              [userId]
            );

            if (userResult.rows.length > 0) {
              await queueService.addJob(QueueName.EMAIL_NOTIFICATIONS, {
                type: 'payout_confirmation',
                to: userResult.rows[0].email,
                data: {
                  payoutId,
                  amount,
                  eventName: event.name,
                },
              });
            }
          }
        });

        return { 
          status: 'completed', 
          transferId: transfer.id,
          amount: transfer.amount / 100,
        };
      } catch (error) {
        logger.error('Payout processing error', { eventId, userId, error });
        throw error;
      }
    }
  );
}