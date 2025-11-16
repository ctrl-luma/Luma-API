import dotenv from 'dotenv';
import { z } from 'zod';
import { existsSync } from 'fs';

// Load environment-specific .env file
const envFile = `.env.${process.env.NODE_ENV || 'local'}`;
if (existsSync(envFile)) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config({ path: '.env.local' });
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'local']).default('development'),
  PORT: z.string().transform(Number).default('3334'),
  API_URL: z.string().url().default('http://localhost:3334'),
  
  DATABASE_URL: z.string(),
  DB_SSL: z.string().transform(v => v === 'true').default('false'),
  
  REDIS_URL: z.string().default('redis://localhost:6379'),
  
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  
  AWS_REGION: z.string().optional(),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  COGNITO_CLIENT_SECRET: z.string().optional(),
  
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),
  
  CORS_ORIGIN: z.string().default('http://localhost:3001,http://localhost:3002'),
  
  SOCKET_IO_PATH: z.string().default('/socket.io'),
  
  BULL_REDIS_HOST: z.string().default('localhost'),
  BULL_REDIS_PORT: z.string().transform(Number).default('6379'),
});

const env = envSchema.parse(process.env);

export const config = {
  env: env.NODE_ENV,
  server: {
    port: env.PORT,
  },
  api: {
    url: env.API_URL,
  },
  database: {
    url: env.DATABASE_URL,
    ssl: env.DB_SSL,
  },
  redis: {
    url: env.REDIS_URL,
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    connectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET,
  },
  aws: {
    region: env.AWS_REGION,
    cognito: {
      userPoolId: env.COGNITO_USER_POOL_ID,
      clientId: env.COGNITO_CLIENT_ID,
      clientSecret: env.COGNITO_CLIENT_SECRET,
    },
  },
  logging: {
    level: env.LOG_LEVEL,
  },
  cors: {
    origin: env.CORS_ORIGIN,
  },
  socketio: {
    path: env.SOCKET_IO_PATH,
  },
  bull: {
    redis: {
      host: env.BULL_REDIS_HOST,
      port: env.BULL_REDIS_PORT,
    },
  },
} as const;

export type Config = typeof config;