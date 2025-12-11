import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { emailService } from '../services/email';
import { logger } from '../utils/logger';

const app = new OpenAPIHono();

const ContactRequestSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  company: z.string().min(1),
  message: z.string().min(1),
});

const contactRoute = createRoute({
  method: 'post',
  path: '/',
  summary: 'Submit a contact request',
  tags: ['Contact'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ContactRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Contact request sent successfully',
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
      description: 'Invalid request data',
    },
    500: {
      description: 'Failed to send contact request',
    },
  },
});

app.openapi(contactRoute, async (c) => {
  const body = await c.req.json();
  
  try {
    const validatedData = ContactRequestSchema.parse(body);
    const { name, email, company, message } = validatedData;

    const supportEmail = process.env.SUPPORT_EMAIL || 'support@lumapos.co';

    const html = `
      <h2>New Contact Request</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Company:</strong> ${company}</p>
      <p><strong>Message:</strong></p>
      <p>${message.replace(/\n/g, '<br>')}</p>
      <hr>
      <p style="color: #666; font-size: 12px;">
        This message was sent from the Luma POS contact form.
      </p>
    `;

    const text = `New Contact Request

Name: ${name}
Email: ${email}
Company: ${company}

Message:
${message}

---
This message was sent from the Luma POS contact form.`;

    await emailService.sendEmail({
      to: supportEmail,
      subject: `Contact Request from ${name} (${company})`,
      html,
      text,
      replyTo: email
    });

    logger.info('Contact request sent', {
      name,
      email,
      company,
      supportEmail
    });

    return c.json({
      success: true,
      message: 'Contact request sent successfully'
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid request data', details: error.errors }, 400);
    }
    
    logger.error('Failed to send contact request', { error });
    return c.json({ error: 'Failed to send contact request. Please try again later.' }, 500);
  }
});

export default app;