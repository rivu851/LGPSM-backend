import mongoose, { Document, Schema } from 'mongoose';
import { INoticeChannel, NOTICE_CHANNEL_STATUSES } from './CancellationNotice';

// Outbox for "your access pass was replaced / revoked" messages: one row per credential event, one state per channel, using the
// same states and meaning as CancellationNotice (SENT = the provider accepted it, never "delivered"; UNKNOWN = interrupted
// mid-send, retried only with an explicit acknowledgement).

export interface IPassNotice extends Document {
  eventId: mongoose.Types.ObjectId;
  inviteeId: mongoose.Types.ObjectId;
  organizerId: mongoose.Types.ObjectId;
  credentialEventId: mongoose.Types.ObjectId;
  kind: 'REPLACED' | 'REVOKED';
  credentialVersion: number;
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

const PassNoticeSchema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    inviteeId: { type: Schema.Types.ObjectId, ref: 'Invitee', required: true },
    organizerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    credentialEventId: { type: Schema.Types.ObjectId, ref: 'CredentialEvent', required: true },
    kind: { type: String, enum: ['REPLACED', 'REVOKED'], required: true },
    credentialVersion: { type: Number, required: true },
    email: { type: ChannelSchema, default: () => ({}) },
    whatsapp: { type: ChannelSchema, default: () => ({}) }
  },
  { timestamps: true }
);

// one notice per credential change: creating it twice is impossible, which makes enqueueing idempotent
PassNoticeSchema.index({ credentialEventId: 1 }, { unique: true });
PassNoticeSchema.index({ eventId: 1, createdAt: -1 });

export const PassNotice = mongoose.model<IPassNotice>('PassNotice', PassNoticeSchema);
