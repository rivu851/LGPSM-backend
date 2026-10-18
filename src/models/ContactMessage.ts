import mongoose, { Document, Schema } from 'mongoose';

export enum ContactMessageStatus {
  NEW = 'NEW',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED'
}

// A message submitted through the public "Contact" form. Persisted before anything else happens, so
// a failing admin notification can never lose the request.
export interface IContactMessage extends Document {
  name: string;
  email: string;
  phone?: string;
  message: string;
  status: ContactMessageStatus;
  // sha256(email + normalised message): lets a retry / double-click be recognised as the same request
  fingerprint: string;
  // fingerprint + 10-minute time bucket; the unique index makes concurrent identical submissions (double click, retry) collapse to one row
  dedupeKey: string;
  // Keyed hash of the client IP (abuse analysis without storing the raw address) and a truncated user agent
  ipHash?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ContactMessageSchema: Schema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 20 },
    message: { type: String, required: true, maxlength: 2000 },
    status: { type: String, enum: Object.values(ContactMessageStatus), default: ContactMessageStatus.NEW },
    fingerprint: { type: String, required: true },
    dedupeKey: { type: String, required: true, unique: true },
    ipHash: { type: String },
    userAgent: { type: String, maxlength: 200 }
  },
  { timestamps: true }
);

ContactMessageSchema.index({ status: 1, createdAt: -1 });
ContactMessageSchema.index({ fingerprint: 1, createdAt: -1 });

export const ContactMessage = mongoose.model<IContactMessage>('ContactMessage', ContactMessageSchema);
