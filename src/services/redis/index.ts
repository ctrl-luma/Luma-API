import { createClient, RedisClientType } from 'redis';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export class RedisService {
  private client: RedisClientType;
  private isConnected: boolean = false;

  constructor() {
    this.client = createClient({
      url: config.redis.url,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logger.error('Redis: Max reconnection attempts reached');
            return new Error('Max reconnection attempts reached');
          }
          const delay = Math.min(retries * 100, 3000);
          logger.warn(`Redis: Reconnecting attempt ${retries}, delay ${delay}ms`);
          return delay;
        },
      },
    });

    this.client.on('error', (err) => {
      logger.error('Redis Client Error:', err);
      this.isConnected = false;
    });

    this.client.on('connect', () => {
      logger.info('Redis Client Connected');
      this.isConnected = true;
    });

    this.client.on('ready', () => {
      logger.info('Redis Client Ready');
    });

    this.client.on('end', () => {
      logger.warn('Redis Client Connection Closed');
      this.isConnected = false;
    });
  }

  async connect(): Promise<void> {
    if (!this.isConnected) {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.isConnected) {
      await this.client.quit();
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      logger.error('Redis GET error:', { key, error });
      return null;
    }
  }

  async set(key: string, value: string, ttl?: number): Promise<boolean> {
    try {
      if (ttl) {
        await this.client.set(key, value, { EX: ttl });
      } else {
        await this.client.set(key, value);
      }
      return true;
    } catch (error) {
      logger.error('Redis SET error:', { key, error });
      return false;
    }
  }

  async del(key: string): Promise<number> {
    try {
      return await this.client.del(key);
    } catch (error) {
      logger.error('Redis DEL error:', { key, error });
      return 0;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error('Redis EXISTS error:', { key, error });
      return false;
    }
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    try {
      const result = await this.client.expire(key, ttl);
      return result === 1;
    } catch (error) {
      logger.error('Redis EXPIRE error:', { key, error });
      return false;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(key);
    } catch (error) {
      logger.error('Redis TTL error:', { key, error });
      return -1;
    }
  }

  async incr(key: string): Promise<number | null> {
    try {
      return await this.client.incr(key);
    } catch (error) {
      logger.error('Redis INCR error:', { key, error });
      return null;
    }
  }

  async hget(key: string, field: string): Promise<string | null> {
    try {
      return await this.client.hGet(key, field);
    } catch (error) {
      logger.error('Redis HGET error:', { key, field, error });
      return null;
    }
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    try {
      return await this.client.hSet(key, field, value);
    } catch (error) {
      logger.error('Redis HSET error:', { key, field, error });
      return 0;
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    try {
      return await this.client.hGetAll(key);
    } catch (error) {
      logger.error('Redis HGETALL error:', { key, error });
      return {};
    }
  }

  async hdel(key: string, field: string): Promise<number> {
    try {
      return await this.client.hDel(key, field);
    } catch (error) {
      logger.error('Redis HDEL error:', { key, field, error });
      return 0;
    }
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    try {
      return await this.client.sAdd(key, members);
    } catch (error) {
      logger.error('Redis SADD error:', { key, error });
      return 0;
    }
  }

  async smembers(key: string): Promise<string[]> {
    try {
      return await this.client.sMembers(key);
    } catch (error) {
      logger.error('Redis SMEMBERS error:', { key, error });
      return [];
    }
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    try {
      return await this.client.sRem(key, members);
    } catch (error) {
      logger.error('Redis SREM error:', { key, error });
      return 0;
    }
  }

  async flushall(): Promise<void> {
    try {
      await this.client.flushAll();
      logger.warn('Redis: All data flushed');
    } catch (error) {
      logger.error('Redis FLUSHALL error:', error);
    }
  }
}

export const redisService = new RedisService();