import mongoose, { Document, Schema } from 'mongoose';

export enum AccessControl {
  NO_RESTRICTION = 'NO_RESTRICTION',
  ONLY_ONCE = 'ONLY_ONCE'
}

export enum InviteeSource {
  NEW_LIST = 'NEW_LIST',
  COPY_SESSION = 'COPY_SESSION'
}

export interface ISession extends Document {
  eventId: mongoose.Types.ObjectId;
  name: string;
  schedule: {
    start: Date;
    end: Date;
  };
  // Optional own admission window for this session; absent = only the event's window applies
  admission?: { opensAt?: Date | null; closesAt?: Date | null };
  accessControl: AccessControl;
  validateAgainstOtherSessions: boolean;
  inviteeSource: InviteeSource;
  sourceSessionId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const SessionSchema: Schema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    name: { type: String, required: true, maxlength: 100 },
    schedule: {
      start: { type: Date, required: true },
      end: { type: Date, required: true }
    },
    admission: {
      opensAt: { type: Date, default: undefined },
      closesAt: { type: Date, default: undefined }
    },
    accessControl: { 
      type: String, 
      enum: Object.values(AccessControl), 
      default: AccessControl.ONLY_ONCE, 
      required: true 
    },
    validateAgainstOtherSessions: { type: Boolean, default: false, required: true },
    inviteeSource: { 
      type: String, 
      enum: Object.values(InviteeSource), 
      default: InviteeSource.NEW_LIST, 
      required: true 
    },
    sourceSessionId: { type: Schema.Types.ObjectId, ref: 'Session', default: null }
  },
  {
    timestamps: true
  }
);

// Indexes
SessionSchema.index({ eventId: 1 });
SessionSchema.index({ eventId: 1, 'schedule.start': 1 });

export const Session = mongoose.model<ISession>('Session', SessionSchema);
