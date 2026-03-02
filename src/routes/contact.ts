import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { emailService } from '../services/email';
import { logger } from '../utils/logger';
import { contactRateLimit } from '../middleware/rate-limit';

const app = new OpenAPIHono();

// Rate limiting on contact form
app.use('/', contactRateLimit);

const ContactRequestSchema = z.object({
  name: z.string().max(100).optional(),
  email: z.string().email().max(254),
  company: z.string().max(200).optional(),
  message: z.string().min(1).max(5000),
  subject: z.string().max(200).optional(),
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
    const { email, message, subject: customSubject } = validatedData;
    const name = validatedData.name || '';
    const company = validatedData.company || '';

    const supportEmail = process.env.SUPPORT_EMAIL || 'support@lumapos.co';

    // Sanitize inputs to prevent email header injection and XSS
    const sanitizeName = (str: string) => str.replace(/[\r\n]/g, ' ').trim();
    const escapeHtml = (str: string) =>
      str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const safeName = sanitizeName(name);
    const safeCompany = sanitizeName(company);

    const htmlParts = [
      `<h2>${customSubject ? escapeHtml(customSubject) : 'New Contact Request'}</h2>`,
      name ? `<p><strong>Name:</strong> ${escapeHtml(safeName)}</p>` : '',
      `<p><strong>Email:</strong> ${escapeHtml(email)}</p>`,
      company ? `<p><strong>Company:</strong> ${escapeHtml(safeCompany)}</p>` : '',
      `<p><strong>Message:</strong></p>`,
      `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
      `<hr>`,
      `<p style="color: #666; font-size: 12px;">This message was sent from the Luma POS website.</p>`,
    ];
    const html = htmlParts.filter(Boolean).join('\n');

    const textParts = [
      customSubject || 'New Contact Request',
      '',
      name ? `Name: ${safeName}` : null,
      `Email: ${email}`,
      company ? `Company: ${safeCompany}` : null,
      '',
      'Message:',
      message,
      '',
      '---',
      'This message was sent from the Luma POS website.',
    ];
    const text = textParts.filter(v => v !== null).join('\n');

    const emailSubject = customSubject
      ? `${customSubject} — ${email}`
      : `Contact Request from ${safeName || email}${safeCompany ? ` (${safeCompany})` : ''}`;

    await emailService.sendEmail({
      to: supportEmail,
      subject: emailSubject,
      html,
      text,
      replyTo: email
    });

    logger.info('Contact request sent', {
      name: name || undefined,
      email,
      company: company || undefined,
      subject: customSubject || undefined,
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