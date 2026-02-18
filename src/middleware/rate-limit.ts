import { MiddlewareHandler } from 'hono';
import { redisService } from '../services/redis';
import { logger } from '../utils/logger';

const RATE_LIMIT_PREFIX = 'luma:ratelimit:';

interface RateLimitOptions {
  /** Max number of requests allowed in the window */
  max: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Key prefix to namespace different limiters */
  keyPrefix: string;
  /** Custom key extractor (defaults to client IP) */
  keyExtractor?: (c: any) => string;
}

function getClientIp(c: any): string {
  const xForwardedFor = c.req.header('x-forwarded-for');
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim();
  }
  const xRealIp = c.req.header('x-real-ip');
  if (xRealIp) return xRealIp;
  return 'unknown';
}

/**
 * Redis-based rate limiting middleware using fixed window counters.
 * Uses INCR + EXPIRE for atomic, race-condition-free counting.
 */
export const rateLimit = (options: RateLimitOptions): MiddlewareHandler => {
  return async (c, next) => {
    const identifier = options.keyExtractor
      ? options.keyExtractor(c)
      : getClientIp(c);

    const key = `${RATE_LIMIT_PREFIX}${options.keyPrefix}:${identifier}`;

    try {
      const count = await redisService.incr(key);

      if (count === null) {
        // Redis error — fail open so legitimate requests aren't blocked
        logger.warn('Rate limit: Redis INCR failed, allowing request', { key });
        return await next();
      }

      // Set expiry on first request in the window
      if (count === 1) {
        await redisService.expire(key, options.windowSeconds);
      }

      // Set rate limit headers
      c.header('X-RateLimit-Limit', String(options.max));
      c.header('X-RateLimit-Remaining', String(Math.max(0, options.max - count)));

      if (count > options.max) {
        const ttl = await redisService.ttl(key);
        c.header('Retry-After', String(ttl > 0 ? ttl : options.windowSeconds));

        logger.warn('Rate limit exceeded', {
          key: options.keyPrefix,
          identifier,
          count,
          max: options.max,
          path: c.req.path,
        });

        return c.json(
          { error: 'Too many requests. Please try again later.' },
          429
        );
      }
    } catch (error) {
      // Fail open on unexpected errors
      logger.error('Rate limit middleware error', { error, key });
    }

    return await next();
  };
};

// ── Pre-configured limiters for auth endpoints ──

/** Login: 10 attempts per 15 minutes per IP */
export const loginRateLimit = rateLimit({
  max: 10,
  windowSeconds: 15 * 60,
  keyPrefix: 'login',
});

/** Signup: 5 attempts per 15 minutes per IP */
export const signupRateLimit = rateLimit({
  max: 5,
  windowSeconds: 15 * 60,
  keyPrefix: 'signup',
});

/** Forgot password: 5 attempts per 15 minutes per IP */
export const forgotPasswordRateLimit = rateLimit({
  max: 5,
  windowSeconds: 15 * 60,
  keyPrefix: 'forgot-password',
});

/** Password reset: 5 attempts per 15 minutes per IP */
export const resetPasswordRateLimit = rateLimit({
  max: 5,
  windowSeconds: 15 * 60,
  keyPrefix: 'reset-password',
});

/** Email/password check: 20 attempts per 15 minutes per IP */
export const checkRateLimit = rateLimit({
  max: 20,
  windowSeconds: 15 * 60,
  keyPrefix: 'check',
});

/** Contact form: 5 submissions per 15 minutes per IP */
export const contactRateLimit = rateLimit({
  max: 5,
  windowSeconds: 15 * 60,
  keyPrefix: 'contact',
});
