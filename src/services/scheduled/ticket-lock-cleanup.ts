import { query } from '../../db';
import { logger } from '../../utils/logger';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

const intervals: ReturnType<typeof setInterval>[] = [];

// --- Ticket Locks: every 15 minutes ---

async function cleanExpiredTicketLocks() {
  try {
    const result = await query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM ticket_locks WHERE expires_at < NOW() RETURNING id
      ) SELECT COUNT(*) AS count FROM deleted`
    );
    const count = parseInt(result[0]?.count || '0');
    if (count > 0) {
      logger.info('Cleaned expired ticket locks', { count });
    }
  } catch (error) {
    logger.error('Failed to clean expired ticket locks', { error });
  }
}

// --- Sessions: every hour ---

async function cleanExpiredSessions() {
  try {
    const result = await query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM sessions WHERE expires_at < NOW() RETURNING id
      ) SELECT COUNT(*) AS count FROM deleted`
    );
    const count = parseInt(result[0]?.count || '0');
    if (count > 0) {
      logger.info('Cleaned expired sessions', { count });
    }
  } catch (error) {
    logger.error('Failed to clean expired sessions', { error });
  }
}

// --- Password Reset Tokens: every hour ---
// Deletes used tokens and tokens expired for more than 24 hours

async function cleanPasswordResetTokens() {
  try {
    const result = await query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM password_reset_tokens
        WHERE used_at IS NOT NULL
          OR expires_at < NOW() - INTERVAL '24 hours'
        RETURNING id
      ) SELECT COUNT(*) AS count FROM deleted`
    );
    const count = parseInt(result[0]?.count || '0');
    if (count > 0) {
      logger.info('Cleaned password reset tokens', { count });
    }
  } catch (error) {
    logger.error('Failed to clean password reset tokens', { error });
  }
}

// --- Start / Stop ---

export function startScheduledCleanups() {
  // Run all once immediately on startup
  cleanExpiredTicketLocks();
  cleanExpiredSessions();
  cleanPasswordResetTokens();

  intervals.push(
    setInterval(cleanExpiredTicketLocks, FIFTEEN_MINUTES),
    setInterval(cleanExpiredSessions, ONE_HOUR),
    setInterval(cleanPasswordResetTokens, ONE_HOUR),
  );

  logger.info('Scheduled cleanups started', {
    ticketLocks: '15m',
    sessions: '1h',
    passwordResetTokens: '1h',
  });
}

export function stopScheduledCleanups() {
  intervals.forEach(clearInterval);
  intervals.length = 0;
}
