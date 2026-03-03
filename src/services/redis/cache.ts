import { redisService } from './index';
import { logger } from '../../utils/logger';

export interface CacheOptions {
  ttl?: number;
  prefix?: string;
}

export class CacheService {
  private defaultTTL = 3600;
  private keyPrefix = 'luma:cache:';

  private buildKey(key: string, prefix?: string): string {
    return `${prefix || this.keyPrefix}${key}`;
  }

  async get<T>(key: string, options?: CacheOptions): Promise<T | null> {
    const cacheKey = this.buildKey(key, options?.prefix);
    
    try {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        logger.debug('Cache hit', { key: cacheKey });
        return JSON.parse(cached) as T;
      }
      logger.debug('Cache miss', { key: cacheKey });
      return null;
    } catch (error) {
      logger.error('Cache get error', { key: cacheKey, error });
      return null;
    }
  }

  async set<T>(key: string, value: T, options?: CacheOptions): Promise<boolean> {
    const cacheKey = this.buildKey(key, options?.prefix);
    const ttl = options?.ttl || this.defaultTTL;
    
    try {
      const serialized = JSON.stringify(value);
      const result = await redisService.set(cacheKey, serialized, ttl);
      if (result) {
        logger.debug('Cache set', { key: cacheKey, ttl });
      }
      return result;
    } catch (error) {
      logger.error('Cache set error', { key: cacheKey, error });
      return false;
    }
  }

  async del(key: string, options?: CacheOptions): Promise<boolean> {
    const cacheKey = this.buildKey(key, options?.prefix);
    
    try {
      const result = await redisService.del(cacheKey);
      logger.debug('Cache deleted', { key: cacheKey, deleted: result > 0 });
      return result > 0;
    } catch (error) {
      logger.error('Cache delete error', { key: cacheKey, error });
      return false;
    }
  }

  async invalidateByPattern(pattern: string): Promise<number> {
    const fullPattern = `${this.keyPrefix}${pattern}`;
    try {
      const deleted = await redisService.deleteByPattern(fullPattern);
      logger.debug('Cache invalidated by pattern', { pattern: fullPattern, deleted });
      return deleted;
    } catch (error) {
      logger.error('Cache invalidateByPattern error', { pattern: fullPattern, error });
      return 0;
    }
  }

  async remember<T>(
    key: string,
    factory: () => Promise<T>,
    options?: CacheOptions
  ): Promise<T> {
    const cached = await this.get<T>(key, options);
    if (cached !== null) {
      return cached;
    }

    const value = await factory();
    await this.set(key, value, options);
    return value;
  }

  async wrap<T>(
    key: string,
    factory: () => Promise<T>,
    options?: CacheOptions
  ): Promise<T> {
    return this.remember(key, factory, options);
  }
}

export const cacheService = new CacheService();

export function cacheKey(...parts: (string | number)[]): string {
  return parts.map(String).join(':');
}

export const CacheKeys = {
  user: (id: string) => cacheKey('user', id),
  userByEmail: (email: string) => cacheKey('user', 'email', email),
  sessionVersion: (userId: string) => cacheKey('session', 'version', userId),
  analyticsPattern: (orgId: string) => `analytics:${orgId}:*`,
} as const;