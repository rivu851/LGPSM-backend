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

export const sendEmail = async (
  to: string,
  subject: string,
  html: string,
  attachments?: EmailAttachment[]
) => {
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
