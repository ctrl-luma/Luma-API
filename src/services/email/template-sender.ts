import { readFileSync } from 'fs';
import { join } from 'path';
import { emailService } from './index';
import { logger } from '../../utils/logger';
import { config } from '../../config';

// Template variable definitions
interface EmailTemplateVariables {
  // Required variables
  subject: string;
  preheader_text: string;
  email_title: string;
  email_content: string; // HTML content that can include paragraphs, lists, etc.
  recipient_email: string;
  current_year: number;
  company_address: string;
  
  // URLs
  site_url: string;
  dashboard_url: string;
  support_url: string;
  
  // Optional variables
  cta_url?: string; // Call-to-action button URL
  cta_text?: string; // Call-to-action button text
  secondary_content?: string; // Additional content in highlighted box
  unsubscribe_url?: string; // Unsubscribe link
  security_notice?: boolean; // Show security notice at bottom
}

// Load and cache the template
let cachedTemplate: string | null = null;

function loadTemplate(): string {
  if (!cachedTemplate) {
    const templatePath = join(__dirname, './templates/email-template.html');
    cachedTemplate = readFileSync(templatePath, 'utf-8');
  }
  return cachedTemplate;
}

// Simple template replacement function (without Handlebars)
function replaceTemplateVariables(template: string, variables: EmailTemplateVariables): string {
  let html = template;
  
  // Replace simple variables
  Object.entries(variables).forEach(([key, value]) => {
    if (typeof value !== 'boolean') {
      const regex = new RegExp(`{{${key}}}`, 'g');
      html = html.replace(regex, String(value || ''));
    }
  });
  
  // Handle triple-brace variables (no escaping) - for HTML content
  Object.entries(variables).forEach(([key, value]) => {
    if (typeof value !== 'boolean') {
      const regex = new RegExp(`{{{${key}}}}`, 'g');
      html = html.replace(regex, String(value || ''));
    }
  });
  
  // Handle conditionals
  html = html.replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (_match, variable, content) => {
    const value = variables[variable as keyof EmailTemplateVariables];
    return value ? content : '';
  });
  
  // Clean up any remaining handlebars syntax
  html = html.replace(/{{[^}]+}}/g, '');
  html = html.replace(/{{{[^}]+}}}/g, '');
  
  return html;
}

// Main function to send templated emails
export async function sendTemplatedEmail(
  to: string,
  templateVariables: Partial<EmailTemplateVariables>
): Promise<void> {
  try {
    // Set default values for required fields
    const currentYear = new Date().getFullYear();
    const defaultVariables: EmailTemplateVariables = {
      subject: 'Message from Luma',
      preheader_text: '',
      email_title: 'Luma Notification',
      email_content: '',
      recipient_email: to,
      current_year: currentYear,
      company_address: 'Luma Inc., San Francisco, CA',
      site_url: config.email.siteUrl!,
      dashboard_url: config.email.dashboardUrl!,
      support_url: config.email.contactUrl!,
    };
    
    // Merge with provided variables
    const variables = { ...defaultVariables, ...templateVariables };
    
    // Load template and replace variables
    const template = loadTemplate();
    const html = replaceTemplateVariables(template, variables);
    
    // Send email using the email service
    await emailService.sendEmail({
      to,
      subject: variables.subject,
      html,
      text: generatePlainText(variables), // Generate plain text version
    });
    
    logger.info('Templated email sent', { to, subject: variables.subject });
  } catch (error) {
    logger.error('Failed to send templated email', { error, to });
    throw error;
  }
}

// Generate plain text version from variables
function generatePlainText(variables: EmailTemplateVariables): string {
  // Strip HTML tags from content
  const plainContent = variables.email_content
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  let text = `${variables.email_title}\n\n${plainContent}`;
  
  if (variables.cta_url && variables.cta_text) {
    text += `\n\n${variables.cta_text}: ${variables.cta_url}`;
  }
  
  if (variables.secondary_content) {
    const plainSecondary = variables.secondary_content
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    text += `\n\n${plainSecondary}`;
  }
  
  text += `\n\n---\n© ${variables.current_year} Luma. All rights reserved.\n${variables.company_address}`;
  
  if (variables.security_notice) {
    text += `\n\nThis email was sent to ${variables.recipient_email}. If you didn't request this email, please ignore it or contact support.`;
  }
  
  return text;
}

// Specific email type functions using the template
export async function sendWelcomeEmail(to: string, userData: { firstName: string; organizationName: string; subscriptionTier: string }): Promise<void> {
  const emailContent = `Hi ${userData.firstName},<br><br>
Welcome to Luma! Your account for <strong>${userData.organizationName}</strong> is all set up and ready to go.<br><br>
To get started with your ${userData.subscriptionTier} plan, head over to your dashboard where you can set up payments, create events, manage inventory, and invite your team.<br><br>
Click the button below to access your dashboard and start exploring.`;

  await sendTemplatedEmail(to, {
    subject: `Welcome to Luma, ${userData.firstName}!`,
    preheader_text: 'Get started with your Luma dashboard',
    email_title: 'Welcome to Luma!',
    email_content: emailContent,
    cta_url: config.email.dashboardUrl!,
    cta_text: 'Go to Your Dashboard',
  });
}

export async function sendPasswordResetEmail(to: string, resetTokenId: string): Promise<void> {
  const resetUrl = `${config.email.dashboardUrl}/reset-password?token=${resetTokenId}`;
  
  logger.info('Preparing password reset email', {
    to,
    resetTokenId,
    resetUrl,
    dashboardUrl: config.email.dashboardUrl,
    defaultFrom: config.email.defaultFrom
  });
  
  const emailContent = `We received a request to reset your password.<br><br>
Click the button below to create a new password. This link will expire in 10 minutes.<br><br>
If you didn't request this password reset, please ignore this email or contact support if you have concerns.`;
  
  await sendTemplatedEmail(to, {
    subject: 'Reset your password - Luma',
    preheader_text: 'Reset your Luma password',
    email_title: 'Password Reset Request',
    email_content: emailContent,
    cta_url: resetUrl,
    cta_text: 'Reset Password',
    security_notice: true,
  });
}

export async function sendOrderConfirmationEmail(to: string, orderData: any): Promise<void> {
  // Format items as a simple list
  const itemsList = orderData.items.map((item: any) => 
    `${item.name} - ${item.quantity} × $${item.price.toFixed(2)}`
  ).join('<br>');
  
  const emailContent = `Thank you for your order at ${orderData.eventName}!<br><br>
<strong>Order ID:</strong> ${orderData.orderId}<br>
<strong>Date:</strong> ${new Date(orderData.date).toLocaleString()}<br><br>
<strong>Items:</strong><br>
${itemsList}<br><br>
<strong>Total:</strong> $${orderData.total.toFixed(2)}<br>
<strong>Payment Method:</strong> ${orderData.paymentMethod}`;
  
  await sendTemplatedEmail(to, {
    subject: `Order Confirmation - ${orderData.orderId}`,
    preheader_text: 'Thank you for your order',
    email_title: 'Order Confirmed!',
    email_content: emailContent,
  });
}

export async function sendReceiptEmail(to: string, receiptData: any): Promise<void> {
  // Format items as a simple list
  const itemsList = receiptData.items.map((item: any) => 
    `${item.quantity} ${item.name} - $${item.subtotal.toFixed(2)}`
  ).join('<br>');
  
  const tipLine = receiptData.tip ? `<br>Tip: $${receiptData.tip.toFixed(2)}` : '';
  
  const emailContent = `<strong>${receiptData.businessName}</strong><br>
${receiptData.eventName}<br><br>
<strong>Transaction:</strong> ${receiptData.transactionId}<br>
<strong>Date:</strong> ${new Date(receiptData.date).toLocaleString()}<br>
<strong>Cashier:</strong> ${receiptData.cashierName}<br><br>
<strong>Items:</strong><br>
${itemsList}<br><br>
Subtotal: $${receiptData.subtotal.toFixed(2)}<br>
Tax: $${receiptData.tax.toFixed(2)}${tipLine}<br>
<strong>TOTAL: $${receiptData.total.toFixed(2)}</strong><br><br>
Payment: ${receiptData.paymentMethod} ${receiptData.last4 ? `****${receiptData.last4}` : ''}<br><br>
Thank you for your purchase!`;
  
  await sendTemplatedEmail(to, {
    subject: `Receipt - ${receiptData.transactionId}`,
    preheader_text: 'Your purchase receipt',
    email_title: 'Receipt',
    email_content: emailContent,
  });
}

export async function sendPayoutEmail(to: string, payoutData: any): Promise<void> {
  const emailContent = `Great news! Your payout has been processed.<br><br>
<strong>Payout Amount:</strong> $${payoutData.amount.toFixed(2)}<br>
<strong>Payout ID:</strong> ${payoutData.payoutId}<br>
<strong>Processing Date:</strong> ${new Date(payoutData.date).toLocaleDateString()}<br>
<strong>Expected Arrival:</strong> ${payoutData.expectedArrival}<br>
<strong>Bank Account:</strong> ****${payoutData.last4}<br><br>
The funds should arrive in your bank account by ${payoutData.expectedArrival}. Processing times may vary depending on your bank.<br><br>
You can view all your payouts and transaction history in your dashboard.`;
  
  await sendTemplatedEmail(to, {
    subject: `Payout Processed - $${payoutData.amount.toFixed(2)}`,
    preheader_text: 'Your payout has been processed',
    email_title: 'Payout Confirmation',
    email_content: emailContent,
  });
}