import crypto from 'crypto';
import { env } from '../config/env';
import { ContactMessage, ContactMessageStatus, IContactMessage } from '../models/ContactMessage';
import { alertService } from './alert.service';

// An identical message from the same address inside this window is treated as a retry / double click
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export interface ContactSubmission {
  name: string;
  email: string;
  phone?: string;
  message: string;
}

export interface ContactRequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface ContactReceipt {
  id: string;
  status: ContactMessageStatus;
  receivedAt: Date;
  duplicate: boolean;
}

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const normaliseForFingerprint = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim();
const toReceipt = (doc: Pick<IContactMessage, 'id' | 'status' | 'createdAt'>, duplicate: boolean): ContactReceipt => ({
  id: String(doc.id),
  status: doc.status,
  receivedAt: doc.createdAt,
  duplicate
});

export const contactService = {
  // Persists first, then alerts admins. A failure while alerting is logged but never undoes (or fails)
  // a request that was already stored.
  async submit(input: ContactSubmission, meta: ContactRequestMeta = {}): Promise<ContactReceipt> {
    const fingerprint = sha256(`${input.email}\n${normaliseForFingerprint(input.message)}`);

    const recent = await ContactMessage.findOne({
      fingerprint,
      createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) }
    }).select('status createdAt');
    if (recent) return toReceipt(recent, true);

    const bucket = Math.floor(Date.now() / DUPLICATE_WINDOW_MS);
    let doc: IContactMessage;
    try {
      doc = await ContactMessage.create({
        name: input.name,
        email: input.email,
        phone: input.phone,
        message: input.message,
        fingerprint,
        dedupeKey: `${fingerprint}:${bucket}`,
        ipHash: meta.ip ? crypto.createHmac('sha256', env.JWT_SECRET).update(meta.ip).digest('hex').slice(0, 32) : undefined,
        userAgent: meta.userAgent?.slice(0, 200)
      });
    } catch (err: any) {
      // A concurrent identical request won the race for the unique dedupe key: report that one
      if (err?.code === 11000) {
        const winner = await ContactMessage.findOne({ fingerprint }).sort({ createdAt: -1 }).select('status createdAt');
        if (winner) return toReceipt(winner, true);
      }
      throw err;
    }

    try {
      const preview = input.message.length > 200 ? `${input.message.slice(0, 200)}…` : input.message;
      await alertService.notifyAdmins('newContactMessage', {
        type: 'CONTACT_MESSAGE',
        title: 'New contact message',
        message: `${input.name} <${input.email}>${input.phone ? ` (${input.phone})` : ''}: ${preview}`,
        entityType: 'CONTACT_MESSAGE',
        entityId: doc._id
      });
    } catch (err) {
      console.error('Contact message stored but admin notification failed:', (err as Error).message);
    }

    return toReceipt(doc, false);
  }
};
