import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env file
dotenv.config({ path: '.env' });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'local']).default('development'),
  PORT: z.string().transform(Number).default('3334'),
  API_URL: z.string().url().default('http://localhost:3334'),
  FRONTEND_URL: z.string().url().default('http://localhost:3333'),
  
  DATABASE_URL: z.string(),
  DB_SSL: z.string().transform(v => v === 'true').default('false'),
  
  REDIS_URL: z.string().default('redis://localhost:6379'),
  
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_PUBLISHABLE_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  STRIPE_ENTERPRISE_PRICE_ID: z.string().optional(),
  
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  COGNITO_CLIENT_SECRET: z.string().optional(),
  
  EMAIL_DEFAULT_FROM: z.string().optional(),
  CONTACT_URL: z.string().optional(),
  DASHBOARD_URL: z.string().optional(),
  SITE_URL: z.string().optional(),
  
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),
  
  CORS_ORIGIN: z.string().default('http://localhost:3001,http://localhost:3002,http://localhost:3333,http://localhost:3336'),
  
  SOCKET_IO_PATH: z.string().default('/socket.io'),
  
  BULL_REDIS_HOST: z.string().default('localhost'),
  BULL_REDIS_PORT: z.string().transform(Number).default('6379'),

  IMAGE_FILE_SERVER_URL: z.string().url().optional(),
  IMAGE_MAX_SIZE_BYTES: z.string().transform(Number).default('5242880'), // 5MB default
  IMAGE_STORAGE_PATH: z.string().default('/data/images'),

  // Google Play Billing
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  GOOGLE_PLAY_CREDENTIALS: z.string().optional(), // JSON string of service account credentials

  // App Download Links
  ANDROID_LINK: z.string().url().optional(),
  IOS_LINK: z.string().url().optional(),
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
  frontend: {
    url: env.FRONTEND_URL,
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
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    connectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET,
    proPriceId: env.STRIPE_PRO_PRICE_ID,
    enterprisePriceId: env.STRIPE_ENTERPRISE_PRICE_ID,
  },
  aws: {
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    cognito: {
      userPoolId: env.COGNITO_USER_POOL_ID,
      clientId: env.COGNITO_CLIENT_ID,
      clientSecret: env.COGNITO_CLIENT_SECRET,
    },
  },
  email: {
    defaultFrom: env.EMAIL_DEFAULT_FROM,
    contactUrl: env.CONTACT_URL,
    dashboardUrl: env.DASHBOARD_URL,
    siteUrl: env.SITE_URL,
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
  images: {
    fileServerUrl: env.IMAGE_FILE_SERVER_URL,
    maxSizeBytes: env.IMAGE_MAX_SIZE_BYTES,
    storagePath: env.IMAGE_STORAGE_PATH,
  },
  googlePlay: {
    packageName: env.GOOGLE_PLAY_PACKAGE_NAME,
    credentials: env.GOOGLE_PLAY_CREDENTIALS,
  },
  appLinks: {
    android: env.ANDROID_LINK,
    ios: env.IOS_LINK,
  },
} as const;

export type Config = typeof config;