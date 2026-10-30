import mongoose, { Document, Schema } from 'mongoose';
import { normalizePhoneNumber } from '../services/whatsapp.service';

export enum InvitationStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED'
}

export enum RsvpStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED'
}

export interface ISessionAccess {
  sessionId: mongoose.Types.ObjectId;
  allowed: boolean;
}

export interface IInvitee extends Document {
  eventId: mongoose.Types.ObjectId;
  name: string;
  email?: string;
  mobile?: string;
  /** The phone number in the one form every duplicate check uses (digits, +91 for ten-digit numbers). Derived on save. */
  mobileKey?: string;
  invitationStatus: InvitationStatus;
  rsvpStatus: RsvpStatus;
  dietaryPreference?: string;
  dietarySelections?: { title: string; value: string }[];
  companyName?: string;
  /** e.g. "Employee ID: 4521" (Add Invitee "Professional Identity"); can be printed on the card */
  professionalIdentity?: string;
  company?: string;
  sessionAccess: ISessionAccess[];
  qrTokenHash?: string;
  qrTokenCipher?: string;
  /** The token in the guest's invitation link (RSVP, page, pass retrieval). Separate from the admission credential above; absent on guests invited before the two were separated. */
  invitationTokenHash?: string;
  invitationTokenCipher?: string;
  /** Identity of the CURRENT admission credential; every history row about it carries the same id */
  credentialId?: mongoose.Types.ObjectId;
  // Set while this guest's CURRENT access pass is revoked; check-in refuses it. A replacement clears it (the revocation itself
  // stays in the CredentialEvent history, with its reason).
  credentialRevokedAt?: Date | null;
  credentialRevocation?: { category: string; note?: string; by?: mongoose.Types.ObjectId; at?: Date } | null;
  // 1 for the first pass; +1 for every re-issue (resend or replacement). Absent on older guests: treated as 1 once a pass exists.
  credentialVersion?: number;
  /** The uploaded list this guest came from (absent on guests added by hand or before lists were tracked) */
  inviteeSetId?: mongoose.Types.ObjectId | null;
  /** Set when a newer upload replaced this never-invited guest. Archived guests are hidden everywhere, never deleted. */
  archivedAt?: Date | null;
  archivedReason?: string;
  supersededBySetId?: mongoose.Types.ObjectId | null;
  archivedBy?: mongoose.Types.ObjectId | null;
  archivedByRole?: string | null;
  /** Last restoration (the earlier set-aside periods stay in `setAsideHistory`) */
  restoredAt?: Date | null;
  restoredBy?: mongoose.Types.ObjectId | null;
  setAsideHistory?: Array<{ archivedAt?: Date; reason?: string; supersededBySetId?: mongoose.Types.ObjectId | null; archivedBy?: mongoose.Types.ObjectId | null; archivedByRole?: string | null; restoredAt: Date; restoredBy: mongoose.Types.ObjectId }>;
  createdAt: Date;
  updatedAt: Date;
}

const SessionAccessSchema = new Schema({
  sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true },
  allowed: { type: Boolean, required: true }
}, { _id: false });

const InviteeSchema: Schema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    name: { type: String, required: true, maxlength: 100 },
    email: { type: String, lowercase: true, trim: true },
    mobile: { type: String, trim: true },
    mobileKey: { type: String, select: false },
    invitationStatus: { 
      type: String, 
      enum: Object.values(InvitationStatus), 
      default: InvitationStatus.PENDING, 
      required: true 
    },
    rsvpStatus: { 
      type: String, 
      enum: Object.values(RsvpStatus), 
      default: RsvpStatus.PENDING, 
      required: true 
    },
    dietaryPreference: { type: String },
    dietarySelections: {
      type: [{ title: { type: String, required: true }, value: { type: String, required: true } }],
      default: undefined
    },
    companyName: { type: String, trim: true },
    professionalIdentity: { type: String, trim: true, maxlength: 100 },
    company: { type: String, trim: true },
    sessionAccess: { type: [SessionAccessSchema], default: [] },
    qrTokenHash: { type: String },
    // Encrypted copy of the current token (see utils/tokenCipher); never returned by default
    qrTokenCipher: { type: String, select: false },
    invitationTokenHash: { type: String },
    invitationTokenCipher: { type: String, select: false },
    credentialId: { type: Schema.Types.ObjectId },
    credentialRevokedAt: { type: Date, default: null },
    credentialRevocation: { type: new Schema({ category: String, note: String, by: Schema.Types.ObjectId, at: Date }, { _id: false }), default: null },
    credentialVersion: { type: Number },
    inviteeSetId: { type: Schema.Types.ObjectId, ref: 'InviteeSet', default: null },
    archivedAt: { type: Date, default: null },
    archivedReason: { type: String },
    supersededBySetId: { type: Schema.Types.ObjectId, ref: 'InviteeSet', default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    archivedByRole: { type: String, default: null },
    restoredAt: { type: Date, default: null },
    restoredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    setAsideHistory: {
      type: [new Schema({ archivedAt: Date, reason: String, supersededBySetId: Schema.Types.ObjectId, archivedBy: Schema.Types.ObjectId, archivedByRole: String, restoredAt: { type: Date, required: true }, restoredBy: { type: Schema.Types.ObjectId, required: true } }, { _id: false })],
      default: undefined
    }
  },
  {
    timestamps: true,
    // whatever serialises a guest (an API response, a log line) leaves the credential material out
    toJSON: { transform: (_doc: unknown, ret: Record<string, unknown>) => { for (const k of ['qrTokenHash', 'qrTokenCipher', 'invitationTokenHash', 'invitationTokenCipher', 'mobileKey']) delete ret[k]; return ret; } }
  }
);

// Indexes
InviteeSchema.index({ eventId: 1 });
InviteeSchema.index({ eventId: 1, email: 1 });
InviteeSchema.index({ eventId: 1, mobile: 1 });

// The phone number in comparison form, kept in step with `mobile` whenever a guest is validated/saved.
InviteeSchema.pre('validate', function (this: IInvitee) {
  this.mobileKey = normalizePhoneNumber(this.mobile) || undefined;
});

// One ACTIVE guest per email and per phone number within an event. The database enforces this, so it holds across
// every backend instance. A guest is active while `archivedAt` is null; set-aside guests are outside these indexes (so
// they never block a re-upload, and restoring one is refused by the database if an active guest has taken its place).
// Guests without an email, or without a usable phone number, are outside them too. Different events are independent.
// The key order differs from the older plain (eventId, email) index on purpose, so that index can stay untouched.
InviteeSchema.index({ email: 1, eventId: 1 }, { name: 'uniq_active_event_email', unique: true, partialFilterExpression: { archivedAt: { $type: 'null' }, email: { $gt: '' } } });
InviteeSchema.index({ mobileKey: 1, eventId: 1 }, { name: 'uniq_active_event_mobile', unique: true, partialFilterExpression: { archivedAt: { $type: 'null' }, mobileKey: { $gt: '' } } });
InviteeSchema.index({ eventId: 1, rsvpStatus: 1 });
InviteeSchema.index({ invitationTokenHash: 1 }, { sparse: true });
// Every door scan looks a guest up by the admission credential's hash: without this each scan reads the whole collection.
InviteeSchema.index({ qrTokenHash: 1 }, { sparse: true });

// Archived (superseded, never-invited) guests are invisible to every read. A query that must see them asks with
// `.setOptions({ includeArchived: true })`; event deletion still removes them with the rest of the event.
const READ_OPS = ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'countDocuments', 'distinct'] as const;
for (const op of READ_OPS) {
  InviteeSchema.pre(op as any, function (this: mongoose.Query<any, any>) {
    if ((this.getOptions() as any).includeArchived) return;
    const filter = this.getFilter() as Record<string, unknown>;
    if (filter.archivedAt === undefined) this.where({ archivedAt: null });
  });
}
InviteeSchema.pre('aggregate', function () {
  if ((this.options as any)?.includeArchived) return;
  this.pipeline().unshift({ $match: { archivedAt: null } });
});
InviteeSchema.index({ eventId: 1, inviteeSetId: 1 });

export const Invitee = mongoose.model<IInvitee>('Invitee', InviteeSchema);
