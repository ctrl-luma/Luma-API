import { Resend } from 'resend';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { formatCurrency, formatSmallestUnit } from '../../utils/currency';

// Initialize Resend client
const resend = config.email.resendApiKey ? new Resend(config.email.resendApiKey) : null;

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
    this.defaultFrom = config.email.defaultFrom || 'Luma <no-reply@lumapos.co>';
    logger.info('EmailService initialized', {
      defaultFrom: this.defaultFrom,
      hasResendKey: !!config.email.resendApiKey,
    });
  }

  async sendEmail(options: EmailOptions): Promise<void> {
    const { to, subject, html, text, from = this.defaultFrom, replyTo } = options;

    const toAddresses = Array.isArray(to) ? to : [to];

    logger.info('Sending email', {
      to: toAddresses,
      from,
      subject,
      hasHtml: !!html,
      hasText: !!text,
      replyTo,
    });

    if (!resend) {
      logger.warn('Resend not configured, skipping email', { to: toAddresses, subject });
      return;
    }

    try {
      const { data, error } = await resend.emails.send({
        from,
        to: toAddresses,
        subject,
        html: html || '',
        text: text || '',
        ...(replyTo && { replyTo }),
      });

      if (error) {
        throw error;
      }

      logger.info('Email sent successfully', {
        messageId: data?.id,
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
    // Resend doesn't have built-in templates, so this is a no-op
    // All our emails use the html templates from template-sender.ts
    logger.warn('sendTemplatedEmail called but Resend does not support server templates', {
      template: options.template,
    });
  }

  // Helper methods for specific email types
  async sendOrderConfirmation(to: string, orderData: any, currency: string = 'usd'): Promise<void> {
    const html = `
      <h1>Order Confirmation</h1>
      <p>Thank you for your order!</p>
      <p>Order ID: ${orderData.orderId}</p>
      <p>Total: ${formatCurrency(orderData.total, currency)}</p>
      <p>Items:</p>
      <ul>
        ${orderData.items.map((item: any) => `
          <li>${item.name} x ${item.quantity} - ${formatCurrency(item.price, currency)}</li>
        `).join('')}
      </ul>
    `;

    await this.sendEmail({
      to,
      subject: `Order Confirmation - ${orderData.orderId}`,
      html,
      text: `Order Confirmation\n\nThank you for your order!\nOrder ID: ${orderData.orderId}\nTotal: ${formatCurrency(orderData.total, currency)}`,
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
  }, currency: string = 'usd'): Promise<void> {
    const { sendVendorTemplatedEmail } = await import('./template-sender');

    const formattedAmount = formatSmallestUnit(receiptData.amount, currency);
    const formattedRefundedAmount = receiptData.amountRefunded
      ? formatSmallestUnit(receiptData.amountRefunded, currency)
      : null;
    const isFullyRefunded = receiptData.amountRefunded === receiptData.amount;
    const isPartiallyRefunded = receiptData.amountRefunded && receiptData.amountRefunded < receiptData.amount;
    const netAmount = receiptData.amountRefunded
      ? formatSmallestUnit(receiptData.amount - receiptData.amountRefunded, currency)
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

    // Build amount section
    let amountSection: string;
    if (isFullyRefunded) {
      amountSection = `
        <p style="margin: 0 0 8px; color: #a3a3a3; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; text-align: center;">Amount Refunded</p>
        <p style="margin: 0; color: #fafafa; font-size: 48px; font-weight: 700; text-align: center;">${formattedRefundedAmount}</p>`;
    } else if (isPartiallyRefunded) {
      amountSection = `
        <p style="margin: 0 0 8px; color: #a3a3a3; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; text-align: center;">Original Amount</p>
        <p style="margin: 0; color: #fafafa; font-size: 48px; font-weight: 700; text-align: center;">${formattedAmount}</p>
        <p style="margin: 12px 0 0; color: #f87171; font-size: 18px; font-weight: 600; text-align: center;">Refunded: ${formattedRefundedAmount}</p>
        <p style="margin: 4px 0 0; color: #4ade80; font-size: 16px; font-weight: 500; text-align: center;">Net: ${netAmount}</p>`;
    } else {
      amountSection = `
        <p style="margin: 0 0 8px; color: #a3a3a3; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; text-align: center;">Amount Paid</p>
        <p style="margin: 0; color: #fafafa; font-size: 48px; font-weight: 700; text-align: center;">${formattedAmount}</p>`;
    }

    // Build status badge
    let statusBadge: string;
    if (isFullyRefunded) {
      statusBadge = `<span style="display: inline-block; background-color: #374151; color: #9ca3af; padding: 8px 16px; border-radius: 9999px; font-size: 14px; font-weight: 500;">↩ Fully Refunded</span>`;
    } else if (isPartiallyRefunded) {
      statusBadge = `<span style="display: inline-block; background-color: #422006; color: #fbbf24; padding: 8px 16px; border-radius: 9999px; font-size: 14px; font-weight: 500;">↩ Partially Refunded</span>`;
    } else {
      statusBadge = `<span style="display: inline-block; background-color: #052e16; color: #4ade80; padding: 8px 16px; border-radius: 9999px; font-size: 14px; font-weight: 500;">✓ Payment Successful</span>`;
    }

    // Build details rows
    const orderNumberRow = receiptData.orderNumber
      ? `<tr><td style="padding: 12px 16px; border-bottom: 1px solid #404040;">
          <p style="margin: 0; color: #a3a3a3; font-size: 13px;">Order Number</p>
          <p style="margin: 4px 0 0; color: #fafafa; font-size: 15px; font-weight: 500;">#${receiptData.orderNumber}</p>
        </td></tr>`
      : '';

    const emailContent = `${amountSection}
      <div style="text-align: center; margin: 16px 0 24px;">${statusBadge}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #262626; border-radius: 8px;">
        <tr><td style="padding: 12px 16px; border-bottom: 1px solid #404040;">
          <p style="margin: 0; color: #a3a3a3; font-size: 13px;">Date</p>
          <p style="margin: 4px 0 0; color: #fafafa; font-size: 15px; font-weight: 500;">${formattedDate}</p>
        </td></tr>
        ${orderNumberRow}
        <tr><td style="padding: 12px 16px;">
          <p style="margin: 0; color: #a3a3a3; font-size: 13px;">Payment Method</p>
          <p style="margin: 4px 0 0; color: #fafafa; font-size: 15px; font-weight: 500;">${paymentMethod}</p>
        </td></tr>
      </table>
      <p style="margin: 24px 0 0; color: #a3a3a3; font-size: 13px; text-align: center;">
        ${receiptData.merchantName ? `Thank you for your purchase from ${receiptData.merchantName}` : 'Thank you for your purchase'}
      </p>`;

    const subjectPrefix = isFullyRefunded ? 'Refund' : isPartiallyRefunded ? 'Updated' : 'Payment';
    const subject = receiptData.orderNumber
      ? `${subjectPrefix} Receipt for Order #${receiptData.orderNumber}`
      : `${subjectPrefix} Receipt - ${isFullyRefunded ? formattedRefundedAmount : formattedAmount}`;

    const titleText = isFullyRefunded ? 'Refund Receipt' : 'Payment Receipt';

    await sendVendorTemplatedEmail(to, {
      subject,
      preheader_text: `${subjectPrefix} receipt${receiptData.orderNumber ? ` for order #${receiptData.orderNumber}` : ''}`,
      email_title: titleText,
      email_content: emailContent,
      cta_url: receiptData.receiptUrl,
      cta_text: 'View Full Receipt',
    }, {
      organizationName: receiptData.merchantName || 'Receipt',
      brandingLogoUrl: null,
    });
  }

  async sendPayoutConfirmation(to: string, payoutData: any, currency: string = 'usd'): Promise<void> {
    const html = `
      <h1>Payout Confirmation</h1>
      <p>Your payout has been processed!</p>
      <p>Payout ID: ${payoutData.payoutId}</p>
      <p>Amount: ${formatCurrency(payoutData.amount, currency)}</p>
      <p>Expected Arrival: ${payoutData.expectedArrival}</p>
    `;

    await this.sendEmail({
      to,
      subject: `Payout Confirmation - ${formatCurrency(payoutData.amount, currency)}`,
      html,
      text: `Payout Confirmation\n\nYour payout has been processed!\nPayout ID: ${payoutData.payoutId}\nAmount: ${formatCurrency(payoutData.amount, currency)}\nExpected Arrival: ${payoutData.expectedArrival}`,
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
