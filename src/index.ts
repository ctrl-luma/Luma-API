import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { requestId } from './middleware/request-id';
import { testConnection } from './db';
import { initializeDatabase } from './db/migrate';
import { logger as winstonLogger } from './utils/logger';
import { redisService } from './services/redis';
import { registerAllWorkers } from './services/queue/workers';
import authRoutes from './routes/auth';
import organizationRoutes from './routes/organizations';
import stripeWebhookRoutes from './routes/stripe/webhooks';
import stripeConnectWebhookRoutes from './routes/stripe/connect-webhooks';
import stripeConnectRoutes from './routes/stripe/connect';
import contactRoutes from './routes/contact';
import marketingRoutes from './routes/marketing';
import { billingRoutes } from './routes/billing';

const app = new OpenAPIHono();

// Register security scheme
app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'JWT Authorization header using the Bearer scheme',
});

app.use('*', logger());
app.use('*', requestId());
// Debug CORS
const corsOrigins = config.cors.origin.split(',').map(origin => origin.trim());
winstonLogger.info('CORS Origins configured:', corsOrigins);

app.use('*', cors({
  origin: corsOrigins,
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use('*', prettyJSON());

app.get('/', (c) => {
  return c.json({
    name: 'Luma API',
    version: '1.0.0',
    status: 'operational',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Luma API',
    version: '1.0.0',
    description: 'Backend API for Luma - Stripe-integrated POS system for mobile bars and events',
  },
  servers: [
    {
      url: config.api.url,
      description: 'API Server',
    },
  ],
});

app.get('/swagger', swaggerUI({ url: '/openapi.json' }));

// Mount routes
app.route('/', authRoutes);
app.route('/', organizationRoutes);
app.route('/', stripeWebhookRoutes);
app.route('/', stripeConnectWebhookRoutes);
app.route('/', stripeConnectRoutes);
app.route('/contact', contactRoutes);
app.route('/marketing', marketingRoutes);
app.route('/', billingRoutes);

app.onError(errorHandler);

const port = config.server.port;

async function startServer() {
  try {
    await testConnection();
    await initializeDatabase();
    await redisService.connect();
    registerAllWorkers();
    
    serve({
      fetch: app.fetch,
      port,
    });
    
    winstonLogger.info(`Server is running on port ${port}`);
  } catch (error) {
    winstonLogger.error('Failed to start server', error);
    process.exit(1);
  }
}

startServer();