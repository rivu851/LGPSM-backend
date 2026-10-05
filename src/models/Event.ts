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
  media: {
    logoKey?: string;
    bannerKey?: string;
  };
  status: EventStatus;
  // Per-invitee rate locked when the event was created (null when no rate was configured then)
  pricing?: { ratePerInvitee: number | null; currency: string; lockedAt: Date };
  operationalDataCleared?: boolean;
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
    operationalDataCleared: { type: Boolean, default: false }
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
