import mongoose, { Document, Schema } from 'mongoose';

// Durable outbox for "this event was cancelled" messages: one row per previously invited guest, one state per channel.
// It is the only record of what was sent, so the organizer can see it and retry without ever sending twice.
//
// Channel states (what actually happened, never more):
//   NOT_USED     the guest's invitation never reached them on this channel, so no notice is sent there
//   PENDING      waiting to be sent
//   SENDING      claimed by a worker; if the process dies here the outcome is unknown (see staleSending in the service)
//   SENT         the provider ACCEPTED the message. This is not delivery: neither SMTP/Brevo nor the WhatsApp API is
//                asked for, or reports, delivery confirmation in this app.
//   FAILED       attempted and refused / errored; may be retried
//   UNKNOWN      the worker died while SENDING: the provider may or may not have accepted the message. It is never retried
//                automatically, and a manual retry may send a duplicate, so it needs the organizer's explicit go-ahead
//   UNAVAILABLE  the provider is not configured (or the channel has no template / the guest has no address); may be
//                retried once that changes

export const NOTICE_CHANNEL_STATUSES = ['NOT_USED', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'UNAVAILABLE', 'UNKNOWN'] as const;
export type NoticeChannelStatus = (typeof NOTICE_CHANNEL_STATUSES)[number];

export interface INoticeChannel {
  status: NoticeChannelStatus;
  attempts: number;
  lastAttemptAt?: Date;
  sentAt?: Date;
  failureReason?: string;
  providerMessageId?: string;
}

export interface ICancellationNotice extends Document {
  eventId: mongoose.Types.ObjectId;
  inviteeId: mongoose.Types.ObjectId;
  organizerId: mongoose.Types.ObjectId;
  email: INoticeChannel;
  whatsapp: INoticeChannel;
  createdAt: Date;
  updatedAt: Date;
}

const ChannelSchema = new Schema(
  {
    status: { type: String, enum: NOTICE_CHANNEL_STATUSES, default: 'NOT_USED' },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date },
    sentAt: { type: Date },
    failureReason: { type: String, maxlength: 300 },
    providerMessageId: { type: String }
  },
  { _id: false }
);

const CancellationNoticeSchema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    inviteeId: { type: Schema.Types.ObjectId, ref: 'Invitee', required: true },
    organizerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: ChannelSchema, default: () => ({}) },
    whatsapp: { type: ChannelSchema, default: () => ({}) }
  },
  { timestamps: true }
);

// One notice per guest per event: creating it twice is impossible, which is what makes enqueueing idempotent
CancellationNoticeSchema.index({ eventId: 1, inviteeId: 1 }, { unique: true });
CancellationNoticeSchema.index({ 'email.status': 1 });
CancellationNoticeSchema.index({ 'whatsapp.status': 1 });

export const CancellationNotice = mongoose.model<ICancellationNotice>('CancellationNotice', CancellationNoticeSchema);
