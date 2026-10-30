import mongoose, { Document, Schema } from 'mongoose';

// Append-only history of a guest's access passes. Rows are never edited or removed (the revocation of a pass stays on record
// with its reason even after the pass is replaced). The raw token is never stored; `tokenHash` is the same one-way hash the
// guest record already holds, kept so a superseded link can be recognised and explained.

// ISSUED: a pass was created and delivered. ACTIVATED: it became the guest's current pass (written with ISSUED / REPLACED).
// REPLACED: a newer pass took over. REVOKED: withdrawn. EXPIRED is not stored: it follows from the event's own state, and the
// history shows it as a derived row.
export const CREDENTIAL_EVENT_TYPES = ['ISSUED', 'ACTIVATED', 'REPLACED', 'REVOKED'] as const;
export type CredentialEventType = (typeof CREDENTIAL_EVENT_TYPES)[number];

export interface ICredentialEvent extends Document {
  eventId: mongoose.Types.ObjectId;
  inviteeId: mongoose.Types.ObjectId;
  organizerId: mongoose.Types.ObjectId;
  type: CredentialEventType;
  /** the pass this row is about: the new pass for ISSUED/REPLACED, the affected pass for REVOKED */
  version: number;
  /** REPLACED only: the pass that was superseded */
  previousVersion?: number;
  /** The credential this row is about (stable across its issue, activation and revocation) and, for a replacement, the one it replaced */
  credentialId?: mongoose.Types.ObjectId;
  previousCredentialId?: mongoose.Types.ObjectId;
  result?: 'SUCCESS';
  source: 'SEND' | 'RESEND' | 'REPLACE' | 'REVOKE';
  reasonCategory?: string;
  note?: string;
  actorId?: mongoose.Types.ObjectId;
  actorRole?: string;
  /** a replacement of a pass that had been revoked for a reason needing review: who confirmed it */
  reviewConfirmed?: boolean;
  tokenHash?: string;
  createdAt: Date;
}

const CredentialEventSchema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    inviteeId: { type: Schema.Types.ObjectId, ref: 'Invitee', required: true },
    organizerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: CREDENTIAL_EVENT_TYPES, required: true },
    version: { type: Number, required: true },
    previousVersion: { type: Number },
    credentialId: { type: Schema.Types.ObjectId },
    previousCredentialId: { type: Schema.Types.ObjectId },
    result: { type: String, enum: ['SUCCESS'], default: 'SUCCESS' },
    source: { type: String, enum: ['SEND', 'RESEND', 'REPLACE', 'REVOKE'], required: true },
    reasonCategory: { type: String },
    note: { type: String, maxlength: 500 },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    reviewConfirmed: { type: Boolean },
    tokenHash: { type: String, select: false }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

CredentialEventSchema.index({ eventId: 1, createdAt: -1 });
CredentialEventSchema.index({ inviteeId: 1, createdAt: 1 });
CredentialEventSchema.index({ tokenHash: 1 }, { sparse: true });

export const CredentialEvent = mongoose.model<ICredentialEvent>('CredentialEvent', CredentialEventSchema);
