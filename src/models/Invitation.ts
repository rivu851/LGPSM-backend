import mongoose, { Document, Schema } from 'mongoose';

export enum DeliveryChannel {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  WHATSAPP = 'WHATSAPP',
  BOTH = 'BOTH'
}

export enum InvitationDeliveryStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED'
}

export interface IInvitation extends Document {
  eventId: mongoose.Types.ObjectId;
  inviteeId: mongoose.Types.ObjectId;
  channel: DeliveryChannel;
  status: InvitationDeliveryStatus;
  sentAt?: Date;
  failureReason?: string;
  tokenHash: string;
  emailStatus?: InvitationDeliveryStatus;
  emailFailureReason?: string;
  whatsappStatus?: InvitationDeliveryStatus;
  whatsappMessageId?: string;
  whatsappFailureReason?: string;
  // Set when the organizer clears the delivery history. The record is kept (resend and QR-supersede checks
  // depend on it) but is hidden from the history list until the next send or resend of that guest.
  clearedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const InvitationSchema: Schema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    inviteeId: { type: Schema.Types.ObjectId, ref: 'Invitee', required: true },
    channel: {
      type: String,
      enum: Object.values(DeliveryChannel),
      required: true
    },
    status: {
      type: String,
      enum: Object.values(InvitationDeliveryStatus),
      default: InvitationDeliveryStatus.PENDING,
      required: true
    },
    sentAt: { type: Date },
    failureReason: { type: String },
    tokenHash: { type: String, required: true },
    emailStatus: { type: String, enum: Object.values(InvitationDeliveryStatus) },
    emailFailureReason: { type: String },
    whatsappStatus: { type: String, enum: Object.values(InvitationDeliveryStatus) },
    whatsappMessageId: { type: String },
    whatsappFailureReason: { type: String },
    clearedAt: { type: Date }
  },
  {
    timestamps: true
  }
);

// Indexes for fast querying and status tracking
InvitationSchema.index({ eventId: 1 });
InvitationSchema.index({ inviteeId: 1 });
InvitationSchema.index({ eventId: 1, inviteeId: 1 });
InvitationSchema.index({ status: 1 });
InvitationSchema.index({ tokenHash: 1 });

export const Invitation = mongoose.model<IInvitation>('Invitation', InvitationSchema);
