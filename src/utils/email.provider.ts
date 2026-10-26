import nodemailer from 'nodemailer';
import { env } from '../config/env';

export interface EmailAttachment {
  filename?: string;
  content?: string | Buffer;
  path?: string;
  cid?: string;
  contentType?: string;
  encoding?: string;
}

// "Name <address>" or a bare address, as accepted by SMTP_FROM
const parseSender = (from: string): { name?: string; email: string } => {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return match ? { name: match[1].trim() || undefined, email: match[2].trim() } : { email: from.trim() };
};

// Hosts such as Render's free tier block outbound SMTP, so mail without inline attachments can go over HTTPS instead
const sendViaBrevoApi = async (apiKey: string, to: string, subject: string, html: string) => {
  const sender = parseSender(process.env.BREVO_SENDER || process.env.SMTP_FROM || '');
  if (!sender.email) {
    console.error('Email Delivery Error: BREVO_SENDER (or SMTP_FROM) is not set.');
    throw new Error('PROVIDER_NOT_CONFIGURED');
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error('Email Delivery Error: Brevo API responded with', res.status);
      throw new Error('FAILED_TO_SEND_EMAIL');
    }
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'FAILED_TO_SEND_EMAIL') throw error;
    console.error('Email Delivery Error:', error instanceof Error ? error.message : 'Unknown error');
    throw new Error('FAILED_TO_SEND_EMAIL');
  }
};

export const sendEmail = async (
  to: string,
  subject: string,
  html: string,
  attachments?: EmailAttachment[]
) => {
  const brevoApiKey = process.env.BREVO_API_KEY;
  if (brevoApiKey && !attachments?.length) {
    return sendViaBrevoApi(brevoApiKey, to, subject, html);
  }

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    // Explicit failure if not configured, rather than silent mock success
    console.error('Email Delivery Error: SMTP credentials are not fully configured in environment variables.');
    throw new Error('PROVIDER_NOT_CONFIGURED');
  }

  const transporter = nodemailer.createTransport({
    host,
    port: parseInt(port || '587', 10),
    // Without these a blocked or unreachable SMTP host leaves the request hanging for minutes
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: {
      user,
      pass
    }
  });



  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || '"Event Management Platform" <noreply@events.local>',
      to,
      subject,
      html,
      attachments
    });
    // Do not log PII or full response unless in debug mode
    return true;
  } catch (error) {
    console.error('Email Delivery Error:', error instanceof Error ? error.message : 'Unknown error');
    throw new Error('FAILED_TO_SEND_EMAIL');
  }
};
