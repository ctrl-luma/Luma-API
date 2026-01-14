import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { query } from '../db';
import { logger } from '../utils/logger';
import { config } from '../config';

const app = new OpenAPIHono();

const SubscribeRequestSchema = z.object({
  email: z.string().email(),
  source: z.string().optional().default('website'),
});

const subscribeRoute = createRoute({
  method: 'post',
  path: '/subscribe',
  summary: 'Subscribe to marketing emails',
  tags: ['Marketing'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: SubscribeRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Successfully subscribed',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid email address',
    },
    500: {
      description: 'Failed to subscribe',
    },
  },
});

app.openapi(subscribeRoute, async (c) => {
  const body = await c.req.json();

  try {
    const validatedData = SubscribeRequestSchema.parse(body);
    const { email, source } = validatedData;

    // Upsert - if email exists and was unsubscribed, reactivate it
    const result = await query(
      `INSERT INTO marketing_emails (email, source, is_active, subscribed_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (email)
       DO UPDATE SET
         is_active = TRUE,
         unsubscribed_at = NULL,
         subscribed_at = CASE
           WHEN marketing_emails.is_active = FALSE THEN NOW()
           ELSE marketing_emails.subscribed_at
         END,
         updated_at = NOW()
       RETURNING id, email, is_active`,
      [email.toLowerCase(), source]
    );

    logger.info('Marketing email subscribed', {
      email: email.toLowerCase(),
      source,
      id: (result as any)[0]?.id,
    });

    return c.json({
      success: true,
      message: 'Successfully subscribed to our newsletter!',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid email address', details: error.errors }, 400);
    }

    logger.error('Failed to subscribe email', { error });
    return c.json({ error: 'Failed to subscribe. Please try again later.' }, 500);
  }
});

const unsubscribeRoute = createRoute({
  method: 'post',
  path: '/unsubscribe',
  summary: 'Unsubscribe from marketing emails',
  tags: ['Marketing'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Successfully unsubscribed',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid email address',
    },
    500: {
      description: 'Failed to unsubscribe',
    },
  },
});

app.openapi(unsubscribeRoute, async (c) => {
  const body = await c.req.json();

  try {
    const { email } = z.object({ email: z.string().email() }).parse(body);

    await query(
      `UPDATE marketing_emails
       SET is_active = FALSE, unsubscribed_at = NOW(), updated_at = NOW()
       WHERE email = $1`,
      [email.toLowerCase()]
    );

    logger.info('Marketing email unsubscribed', { email: email.toLowerCase() });

    return c.json({
      success: true,
      message: 'Successfully unsubscribed from our newsletter.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid email address', details: error.errors }, 400);
    }

    logger.error('Failed to unsubscribe email', { error });
    return c.json({ error: 'Failed to unsubscribe. Please try again later.' }, 500);
  }
});

// App download links endpoint
const appLinksRoute = createRoute({
  method: 'get',
  path: '/app-links',
  summary: 'Get app download links',
  tags: ['Marketing'],
  responses: {
    200: {
      description: 'App download links',
      content: {
        'application/json': {
          schema: z.object({
            android: z.string().nullable(),
            ios: z.string().nullable(),
          }),
        },
      },
    },
  },
});

app.openapi(appLinksRoute, async (c) => {
  return c.json({
    android: config.appLinks.android || null,
    ios: config.appLinks.ios || null,
  });
});

export default app;
