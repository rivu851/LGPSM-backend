import mongoose, { Document, Schema } from 'mongoose';

// Platform-wide settings managed by the Super Admin. Stored as a single document (key: 'global').

export interface IEventFeatures {
  allowEventRSVP: boolean;
  acceptInvitedAttendees: boolean;
  chooseNotRespondedInvitees: boolean;
  chooseRSVPDeclinedInvitees: boolean;
  askFoodPreference: boolean;
}

export interface INotificationPreferences {
  newOrganizerRegistration: boolean;
  newEventAdded: boolean;
  deactivatedOrganizerBySuperAdmin: boolean;
  changeInPrice: boolean;
  invitationSendFailed: boolean;
  dayBeforeEventAlert: boolean;
  reportDownload: boolean;
  customTemplateRequest: boolean;
}

export interface IPlatformSettings extends Document {
  key: string;
  eventFeatures: IEventFeatures;
  notificationPreferences: INotificationPreferences;
  pricing: {
    // null until the admin sets a rate
    ratePerInvitee: number | null;
    currency: string;
    updatedAt?: Date;
    updatedBy?: mongoose.Types.ObjectId;
  };
  createdAt: Date;
  updatedAt: Date;
}

const on = { type: Boolean, default: true };
const off = { type: Boolean, default: false };

const PlatformSettingsSchema = new Schema<IPlatformSettings>(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    eventFeatures: {
      allowEventRSVP: on,
      acceptInvitedAttendees: on,
      chooseNotRespondedInvitees: on,
      chooseRSVPDeclinedInvitees: on,
      askFoodPreference: on
    },
    notificationPreferences: {
      newOrganizerRegistration: on,
      newEventAdded: on,
      deactivatedOrganizerBySuperAdmin: on,
      changeInPrice: on,
      invitationSendFailed: on,
      dayBeforeEventAlert: on,
      reportDownload: off,
      customTemplateRequest: on
    },
    pricing: {
      ratePerInvitee: { type: Number, default: null, min: 0 },
      currency: { type: String, default: 'USD' },
      updatedAt: { type: Date },
      updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
    }
  },
  { timestamps: true }
);

export const PlatformSettings = mongoose.model<IPlatformSettings>('PlatformSettings', PlatformSettingsSchema);
