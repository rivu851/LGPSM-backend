import nodemailer from 'nodemailer';
import { publicApiUrl } from './publicUrl';
export { publicApiUrl };

export interface EmailAttachment {
  filename?: string;
  content?: string | Buffer;
  path?: string;
  cid?: string;
  contentType?: string;
  encoding?: string;
  /**
   * A public https address of this same image. Mail services used over HTTPS cannot embed an image by attachment (`cid:`), so the email
   * links to this address instead. Without one, only an `essential` image (the card, the QR) is attached as a plain file.
   */
  url?: string;
  /** the guest needs this image even when it cannot be shown inside the email (their card, their QR) */
  essential?: boolean;
}

// "Name <address>" or a bare address, as accepted by SMTP_FROM
const parseSender = (from: string): { name?: string; email: string } => {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return match ? { name: match[1].trim() || undefined, email: match[2].trim() } : { email: from.trim() };
};

// Hosts such as Render's free tier block outbound SMTP, so mail goes over HTTPS (Brevo's API) whenever BREVO_API_KEY is set
const sendViaBrevoApi = async (apiKey: string, to: string, subject: string, html: string, attachments?: EmailAttachment[]) => {
  const sender = parseSender(process.env.BREVO_SENDER || process.env.SMTP_FROM || '');
  if (!sender.email) {
    console.error('Email Delivery Error: BREVO_SENDER (or SMTP_FROM) is not set.');
    throw new Error('PROVIDER_NOT_CONFIGURED');
  }
  // Brevo's API cannot embed an image by attachment: each `cid:` image becomes a link to its public address, and an image with no
  // public address is attached as a plain file only when the guest needs it (their card, their QR)
  let body = html;
  const files: { name: string; content: string }[] = [];
  for (const a of attachments ?? []) {
    if (a.cid && a.url) {
      body = body.split(`cid:${a.cid}`).join(a.url);
      // the guest's card and QR also go as a plain file, so a mail app that blocks remote images still gives them their pass
      if (!a.essential) continue;
    }
    if (a.cid && !a.essential) continue;
    const content = Buffer.isBuffer(a.content) ? a.content.toString('base64') : typeof a.content === 'string' ? Buffer.from(a.content, a.encoding === 'base64' ? 'base64' : 'utf8').toString('base64') : null;
    if (content && a.filename) files.push({ name: a.filename.includes('.') ? a.filename : `${a.filename}.png`, content });
  }
  // an image that could not be linked (and cannot be embedded) is dropped from the HTML, so the mail app never shows a broken-image box
  body = body.replace(/<img\b[^>]*\bsrc="cid:[^"]*"[^>]*>/gi, '');
  if (attachments?.some((a) => a.cid && !a.url) && !publicApiUrl()) {
    console.warn('Email: PUBLIC_API_URL is not set, so the images inside emails cannot be linked; the card and QR go as attachments only.');
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: body, ...(files.length ? { attachment: files } : {}) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // Brevo says why in a short JSON message (for example an unverified sender); the response never contains our key
      const detail = await res.json().then((j: any) => `${j?.code ?? ''} ${j?.message ?? ''}`.trim()).catch(() => '');
      console.error('Email Delivery Error: Brevo API responded with', res.status, detail);
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
  if (brevoApiKey) {
    return sendViaBrevoApi(brevoApiKey, to, subject, html, attachments);
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
    // port 465 is TLS from the first byte (SMTPS); 587 and 25 start plain and upgrade (STARTTLS). SMTP_SECURE=true/false overrides.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : parseInt(port || '587', 10) === 465,
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
