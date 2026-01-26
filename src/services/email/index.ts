import { SESClient, SendEmailCommand, SendTemplatedEmailCommand } from '@aws-sdk/client-ses';
import { config } from '../../config';
import { logger } from '../../utils/logger';

// Initialize SES client
const sesClient = new SESClient({
  region: config.aws.region || 'us-east-1',
  credentials: config.aws.accessKeyId && config.aws.secretAccessKey ? {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  } : undefined, // Use IAM role if no credentials provided
});

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
}

export interface TemplatedEmailOptions {
  to: string | string[];
  template: string;
  templateData: Record<string, any>;
  from?: string;
  replyTo?: string;
}

export class EmailService {
  private defaultFrom: string;

  constructor() {
    this.defaultFrom = config.email.defaultFrom!;
    logger.info('EmailService initialized', { 
      defaultFrom: this.defaultFrom,
      hasDefaultFrom: !!config.email.defaultFrom,
      configValue: config.email.defaultFrom 
    });
  }

  async sendEmail(options: EmailOptions): Promise<void> {
    const { to, subject, html, text, from = this.defaultFrom, replyTo } = options;
    
    const toAddresses = Array.isArray(to) ? to : [to];

    logger.info('Sending email', {
      to: toAddresses,
      from,
      defaultFrom: this.defaultFrom,
      subject,
      hasHtml: !!html,
      hasText: !!text,
      replyTo,
      awsRegion: config.aws.region || 'us-east-1'
    });

    try {
      const command = new SendEmailCommand({
        Source: from,
        Destination: {
          ToAddresses: toAddresses,
        },
        Message: {
          Subject: {
            Data: subject,
            Charset: 'UTF-8',
          },
          Body: {
            ...(html && {
              Html: {
                Data: html,
                Charset: 'UTF-8',
              },
            }),
            ...(text && {
              Text: {
                Data: text,
                Charset: 'UTF-8',
              },
            }),
          },
        },
        ...(replyTo && { ReplyToAddresses: [replyTo] }),
      });

      const response = await sesClient.send(command);
      
      logger.info('Email sent successfully', {
        messageId: response.MessageId,
        to: toAddresses,
        subject,
      });
    } catch (error) {
      logger.error('Failed to send email', {
        error,
        to: toAddresses,
        subject,
      });
      throw error;
    }
  }

  async sendTemplatedEmail(options: TemplatedEmailOptions): Promise<void> {
    const { to, template, templateData, from = this.defaultFrom, replyTo } = options;
    
    const toAddresses = Array.isArray(to) ? to : [to];

    try {
      const command = new SendTemplatedEmailCommand({
        Source: from,
        Destination: {
          ToAddresses: toAddresses,
        },
        Template: template,
        TemplateData: JSON.stringify(templateData),
        ...(replyTo && { ReplyToAddresses: [replyTo] }),
      });

      const response = await sesClient.send(command);
      
      logger.info('Templated email sent successfully', {
        messageId: response.MessageId,
        to: toAddresses,
        template,
      });
    } catch (error) {
      logger.error('Failed to send templated email', {
        error,
        to: toAddresses,
        template,
      });
      throw error;
    }
  }

  // Helper methods for specific email types
  async sendOrderConfirmation(to: string, orderData: any): Promise<void> {
    const html = `
      <h1>Order Confirmation</h1>
      <p>Thank you for your order!</p>
      <p>Order ID: ${orderData.orderId}</p>
      <p>Total: $${orderData.total.toFixed(2)}</p>
      <p>Items:</p>
      <ul>
        ${orderData.items.map((item: any) => `
          <li>${item.name} x ${item.quantity} - $${item.price.toFixed(2)}</li>
        `).join('')}
      </ul>
    `;

    await this.sendEmail({
      to,
      subject: `Order Confirmation - ${orderData.orderId}`,
      html,
      text: `Order Confirmation\n\nThank you for your order!\nOrder ID: ${orderData.orderId}\nTotal: $${orderData.total.toFixed(2)}`,
    });
  }

  async sendReceipt(to: string, receiptData: {
    amount: number; // in cents
    amountRefunded?: number; // in cents - if provided, shows refund info
    orderNumber?: string;
    cardBrand?: string;
    cardLast4?: string;
    date: Date;
    receiptUrl?: string;
    merchantName?: string;
  }): Promise<void> {
    const formattedAmount = (receiptData.amount / 100).toFixed(2);
    const formattedRefundedAmount = receiptData.amountRefunded
      ? (receiptData.amountRefunded / 100).toFixed(2)
      : null;
    const isFullyRefunded = receiptData.amountRefunded === receiptData.amount;
    const isPartiallyRefunded = receiptData.amountRefunded && receiptData.amountRefunded < receiptData.amount;
    const netAmount = receiptData.amountRefunded
      ? ((receiptData.amount - receiptData.amountRefunded) / 100).toFixed(2)
      : null;
    const formattedDate = receiptData.date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const paymentMethod = receiptData.cardBrand && receiptData.cardLast4
      ? `${receiptData.cardBrand.toUpperCase()} •••• ${receiptData.cardLast4}`
      : 'Card';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
          <tr>
            <td align="center">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                <!-- Header -->
                <tr>
                  <td style="background: linear-gradient(135deg, ${isFullyRefunded ? '#6b7280 0%, #4b5563 100%' : '#2563eb 0%, #1d4ed8 100%'}); padding: 32px 24px; text-align: center;">
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">${isFullyRefunded ? 'Refund Receipt' : 'Payment Receipt'}</h1>
                  </td>
                </tr>

                <!-- Amount -->
                <tr>
                  <td style="padding: 32px 24px 16px; text-align: center;">
                    ${isFullyRefunded ? `
                    <p style="margin: 0 0 8px; color: #6b7280; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Amount Refunded</p>
                    <p style="margin: 0; color: #111827; font-size: 48px; font-weight: 700;">$${formattedRefundedAmount}</p>
                    ` : isPartiallyRefunded ? `
                    <p style="margin: 0 0 8px; color: #6b7280; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Original Amount</p>
                    <p style="margin: 0; color: #111827; font-size: 48px; font-weight: 700;">$${formattedAmount}</p>
                    <p style="margin: 12px 0 0; color: #dc2626; font-size: 18px; font-weight: 600;">Refunded: $${formattedRefundedAmount}</p>
                    <p style="margin: 4px 0 0; color: #16a34a; font-size: 16px; font-weight: 500;">Net: $${netAmount}</p>
                    ` : `
                    <p style="margin: 0 0 8px; color: #6b7280; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Amount Paid</p>
                    <p style="margin: 0; color: #111827; font-size: 48px; font-weight: 700;">$${formattedAmount}</p>
                    `}
                  </td>
                </tr>

                <!-- Status Badge -->
                <tr>
                  <td style="padding: 0 24px 24px; text-align: center;">
                    ${isFullyRefunded ? `
                    <span style="display: inline-block; background-color: #f3f4f6; color: #6b7280; padding: 8px 16px; border-radius: 9999px; font-size: 14px; font-weight: 500;">
                      ↩ Fully Refunded
                    </span>
                    ` : isPartiallyRefunded ? `
                    <span style="display: inline-block; background-color: #fef3c7; color: #d97706; padding: 8px 16px; border-radius: 9999px; font-size: 14px; font-weight: 500;">
                      ↩ Partially Refunded
                    </span>
                    ` : `
                    <span style="display: inline-block; background-color: #dcfce7; color: #16a34a; padding: 8px 16px; border-radius: 9999px; font-size: 14px; font-weight: 500;">
                      ✓ Payment Successful
                    </span>
                    `}
                  </td>
                </tr>

                <!-- Details -->
                <tr>
                  <td style="padding: 0 24px 24px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border-radius: 8px; padding: 16px;">
                      <tr>
                        <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb;">
                          <p style="margin: 0; color: #6b7280; font-size: 13px;">Date</p>
                          <p style="margin: 4px 0 0; color: #111827; font-size: 15px; font-weight: 500;">${formattedDate}</p>
                        </td>
                      </tr>
                      ${receiptData.orderNumber ? `
                      <tr>
                        <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb;">
                          <p style="margin: 0; color: #6b7280; font-size: 13px;">Order Number</p>
                          <p style="margin: 4px 0 0; color: #111827; font-size: 15px; font-weight: 500;">#${receiptData.orderNumber}</p>
                        </td>
                      </tr>
                      ` : ''}
                      <tr>
                        <td style="padding: 12px 16px;">
                          <p style="margin: 0; color: #6b7280; font-size: 13px;">Payment Method</p>
                          <p style="margin: 4px 0 0; color: #111827; font-size: 15px; font-weight: 500;">${paymentMethod}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                ${receiptData.receiptUrl ? `
                <!-- View Full Receipt Button -->
                <tr>
                  <td style="padding: 0 24px 32px; text-align: center;">
                    <a href="${receiptData.receiptUrl}" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 15px; font-weight: 600;">View Full Receipt</a>
                  </td>
                </tr>
                ` : ''}

                <!-- Footer -->
                <tr>
                  <td style="padding: 24px; background-color: #f9fafb; text-align: center; border-top: 1px solid #e5e7eb;">
                    <p style="margin: 0; color: #6b7280; font-size: 13px;">
                      ${receiptData.merchantName ? `Thank you for your purchase from ${receiptData.merchantName}` : 'Thank you for your purchase'}
                    </p>
                    <p style="margin: 8px 0 0; color: #9ca3af; font-size: 12px;">
                      Powered by Luma POS
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    const subjectPrefix = isFullyRefunded ? 'Refund' : isPartiallyRefunded ? 'Updated' : 'Payment';
    const subject = receiptData.orderNumber
      ? `${subjectPrefix} Receipt for Order #${receiptData.orderNumber}`
      : `${subjectPrefix} Receipt - $${isFullyRefunded ? formattedRefundedAmount : formattedAmount}`;

    const textRefundInfo = isFullyRefunded
      ? `Amount Refunded: $${formattedRefundedAmount}`
      : isPartiallyRefunded
        ? `Original Amount: $${formattedAmount}\nRefunded: $${formattedRefundedAmount}\nNet: $${netAmount}`
        : `Amount: $${formattedAmount}`;

    await this.sendEmail({
      to,
      subject,
      html,
      text: `${isFullyRefunded ? 'Refund' : 'Payment'} Receipt\n\n${textRefundInfo}\nDate: ${formattedDate}${receiptData.orderNumber ? `\nOrder: #${receiptData.orderNumber}` : ''}\nPayment Method: ${paymentMethod}${receiptData.receiptUrl ? `\n\nView full receipt: ${receiptData.receiptUrl}` : ''}\n\n${isFullyRefunded ? 'Your refund has been processed.' : 'Thank you for your purchase!'}`,
    });
  }

  async sendPayoutConfirmation(to: string, payoutData: any): Promise<void> {
    const html = `
      <h1>Payout Confirmation</h1>
      <p>Your payout has been processed!</p>
      <p>Payout ID: ${payoutData.payoutId}</p>
      <p>Amount: $${payoutData.amount.toFixed(2)}</p>
      <p>Expected Arrival: ${payoutData.expectedArrival}</p>
    `;

    await this.sendEmail({
      to,
      subject: `Payout Confirmation - $${payoutData.amount.toFixed(2)}`,
      html,
      text: `Payout Confirmation\n\nYour payout has been processed!\nPayout ID: ${payoutData.payoutId}\nAmount: $${payoutData.amount.toFixed(2)}\nExpected Arrival: ${payoutData.expectedArrival}`,
    });
  }

  async sendPasswordReset(to: string, resetToken: string): Promise<void> {
    const resetUrl = `${config.frontend.url}/reset-password?token=${resetToken}`;
    
    const html = `
      <h1>Password Reset Request</h1>
      <p>You requested to reset your password. Click the link below to reset it:</p>
      <p><a href="${resetUrl}" style="background: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a></p>
      <p>If you didn't request this, please ignore this email.</p>
      <p>This link will expire in 1 hour.</p>
    `;

    await this.sendEmail({
      to,
      subject: 'Password Reset Request - Luma POS',
      html,
      text: `Password Reset Request\n\nYou requested to reset your password. Visit this link to reset it:\n${resetUrl}\n\nIf you didn't request this, please ignore this email.\n\nThis link will expire in 1 hour.`,
    });
  }

  async sendWelcomeEmail(to: string, userData: any): Promise<void> {
    const html = `
      <h1>Welcome to Luma POS!</h1>
      <p>Hi ${userData.firstName},</p>
      <p>Thank you for joining Luma POS. We're excited to have you on board!</p>
      <p>Your account has been created successfully. You can now:</p>
      <ul>
        <li>Set up your payment processing</li>
        <li>Create events and manage inventory</li>
        <li>Start accepting payments</li>
      </ul>
      <p>If you need any help getting started, please don't hesitate to reach out to our support team.</p>
      <p>Best regards,<br>The Luma Team</p>
    `;

    await this.sendEmail({
      to,
      subject: 'Welcome to Luma POS!',
      html,
      text: `Welcome to Luma POS!\n\nHi ${userData.firstName},\n\nThank you for joining Luma POS. We're excited to have you on board!\n\nYour account has been created successfully.\n\nBest regards,\nThe Luma Team`,
    });
  }
}

export const emailService = new EmailService();