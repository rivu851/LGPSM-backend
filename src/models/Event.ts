import { CARD_INFO_FIELDS, CardInfo } from '../utils/cardInfo';
import mongoose, { Document, Schema } from 'mongoose';

export enum EventFormat {
  PHYSICAL = 'PHYSICAL',
  VIRTUAL = 'VIRTUAL'
}

export enum EventStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED'
}

export interface IEvent extends Document {
  organizerId: mongoose.Types.ObjectId;
  title: string;
  description: string;
  categoryId: mongoose.Types.ObjectId;
  subcategoryId?: mongoose.Types.ObjectId;
  format: EventFormat;
  location?: {
    address?: string;
    /** optional full address / directions (the Event Location in `address` is what the card shows) */
    addressDetails?: string;
    coordinates?: {
      type: 'Point';
      coordinates: [number, number]; // [longitude, latitude]
    };
  };
  contactNumber?: string;
  schedule: {
    start: Date;
    end: Date;
  };
  // When guests may be admitted. Absent = follows `schedule` (opens at start, closes at end). Instants are UTC.
  admission?: { opensAt?: Date | null; closesAt?: Date | null };
  rsvp: {
    enabled: boolean;
    acceptanceLastDate?: Date;
    allowAllInvited: boolean;
    allowNotResponded: boolean;
    allowDeclined: boolean;
  };
  attendeeSettings: {
    thresholdLimit?: number;
  };
  dietaryPreference: {
    enabled: boolean;
    title?: string;
    options: any[];
  };
  templateId?: mongoose.Types.ObjectId;
  /** Which guest details the card prints on its two guest lines ("Additional Info"); unset = name, then company */
  cardInfo?: CardInfo;
  media: {
    logoKey?: string;
    bannerKey?: string;
  };
  status: EventStatus;
  // Per-invitee rate locked when the event was created (null when no rate was configured then)
  pricing?: { ratePerInvitee: number | null; currency: string; lockedAt: Date };
  operationalDataCleared?: boolean;
  // Set by the non-destructive close operation; the event and all its history are kept
  closedAt?: Date;
  // Cancellation is terminal (no reinstate). Who/when/why is kept for history and for the guest notices.
  cancelledAt?: Date;
  cancelledBy?: mongoose.Types.ObjectId;
  cancelledByRole?: string;
  cancellationReason?: string;
  // Every admission write bumps `admissionSeq` in the same transaction as the attendance record; close/cancel copy it to
  // `finalAdmissionSeq` in the same atomic update that ends the event. The two must equal the number of attendance
  // records ever admitted, which proves nothing was admitted after the event ended.
  admissionSeq?: number;
  finalAdmissionSeq?: number;
  closedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema: Schema = new Schema(
  {
    organizerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, maxlength: 100 },
    description: { type: String, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    subcategoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
    format: { type: String, enum: Object.values(EventFormat), required: true },
    location: {
      address: { type: String },
      addressDetails: { type: String, maxlength: 300 },
      coordinates: {
        type: { type: String, enum: ['Point'], required: false },
        coordinates: { type: [Number], required: false } // [longitude, latitude]
      }
    },
    contactNumber: { type: String },
    schedule: {
      start: { type: Date, required: true },
      end: { type: Date, required: true }
    },
    admission: {
      opensAt: { type: Date, default: undefined },
      closesAt: { type: Date, default: undefined }
    },
    rsvp: {
      enabled: { type: Boolean, required: true, default: false },
      acceptanceLastDate: { type: Date },
      allowAllInvited: { type: Boolean, required: true, default: true },
      allowNotResponded: { type: Boolean, required: true, default: false },
      allowDeclined: { type: Boolean, required: true, default: false }
    },
    attendeeSettings: {
      thresholdLimit: { type: Number }
    },
    dietaryPreference: {
      enabled: { type: Boolean, required: true, default: false },
      title: { type: String },
      options: { type: [Schema.Types.Mixed], default: [] }
    },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template' },
    cardInfo: {
      primary: { type: String, enum: [...CARD_INFO_FIELDS, null] },
      secondary: { type: String, enum: [...CARD_INFO_FIELDS, null] },
      identityLabel: { type: String, trim: true, maxlength: 40 }
    },
    media: {
      logoKey: { type: String },
      bannerKey: { type: String }
    },
    status: { type: String, enum: Object.values(EventStatus), default: EventStatus.DRAFT, required: true },
    pricing: {
      ratePerInvitee: { type: Number, default: null },
      currency: { type: String },
      lockedAt: { type: Date }
    },
    operationalDataCleared: { type: Boolean, default: false },
    closedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancelledByRole: { type: String },
    cancellationReason: { type: String, maxlength: 500 },
    admissionSeq: { type: Number, default: 0 },
    finalAdmissionSeq: { type: Number },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  {
    timestamps: true
  }
);

// Indexes
EventSchema.index({ organizerId: 1 });
EventSchema.index({ status: 1 });
EventSchema.index({ categoryId: 1 });
EventSchema.index({ 'schedule.start': 1 });
EventSchema.index({ 'location.coordinates': '2dsphere' });

export const Event = mongoose.model<IEvent>('Event', EventSchema);
