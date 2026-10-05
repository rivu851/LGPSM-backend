import mongoose, { Document, Schema } from 'mongoose';

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
  invitationStatus: InvitationStatus;
  rsvpStatus: RsvpStatus;
  dietaryPreference?: string;
  companyName?: string;
  company?: string;
  sessionAccess: ISessionAccess[];
  qrTokenHash?: string;
  qrTokenCipher?: string;
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
    companyName: { type: String, trim: true },
    company: { type: String, trim: true },
    sessionAccess: { type: [SessionAccessSchema], default: [] },
    qrTokenHash: { type: String },
    // Encrypted copy of the current token (see utils/tokenCipher); never returned by default
    qrTokenCipher: { type: String, select: false }
  },
  {
    timestamps: true
  }
);

// Indexes
InviteeSchema.index({ eventId: 1 });
InviteeSchema.index({ eventId: 1, email: 1 });
InviteeSchema.index({ eventId: 1, mobile: 1 });
InviteeSchema.index({ eventId: 1, rsvpStatus: 1 });

export const Invitee = mongoose.model<IInvitee>('Invitee', InviteeSchema);
