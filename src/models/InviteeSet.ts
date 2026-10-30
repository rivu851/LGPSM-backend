import mongoose, { Document, Schema } from 'mongoose';

export enum ImportMode {
  REPLACE = 'REPLACE',
  APPEND = 'APPEND'
}

// One uploaded invitee list. A set is "locked" (derived, see inviteeSet.service) once an invitation from it has been
// dispatched; locked sets are never replaced or removed.
export interface IInviteeSet extends Document {
  eventId: mongoose.Types.ObjectId;
  /** Set when the list was uploaded for a single session */
  sessionId?: mongoose.Types.ObjectId | null;
  name: string;
  mode: ImportMode;
  createdBy?: mongoose.Types.ObjectId;
  createdByRole?: string;
  /** Guests this upload added (rows that matched someone already on the event are not counted) */
  importedCount?: number;
  createdAt: Date;
}

const InviteeSetSchema = new Schema<IInviteeSet>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', default: null },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    mode: { type: String, enum: Object.values(ImportMode), required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByRole: { type: String },
    importedCount: { type: Number, default: 0 }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const InviteeSet = mongoose.model<IInviteeSet>('InviteeSet', InviteeSetSchema);
