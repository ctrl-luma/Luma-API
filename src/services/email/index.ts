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

  async sendReceipt(to: string, receiptData: any): Promise<void> {
    const html = `
      <h1>Receipt</h1>
      <p>Thank you for your purchase!</p>
      <p>Transaction ID: ${receiptData.transactionId}</p>
      <p>Date: ${new Date(receiptData.date).toLocaleString()}</p>
      <p>Total: $${receiptData.total.toFixed(2)}</p>
      <p>Payment Method: ${receiptData.paymentMethod}</p>
    `;

    await this.sendEmail({
      to,
      subject: `Receipt - ${receiptData.transactionId}`,
      html,
      text: `Receipt\n\nThank you for your purchase!\nTransaction ID: ${receiptData.transactionId}\nDate: ${new Date(receiptData.date).toLocaleString()}\nTotal: $${receiptData.total.toFixed(2)}`,
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