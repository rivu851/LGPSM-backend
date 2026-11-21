import mongoose, { Document, Schema } from 'mongoose';

/**
 * The guests chosen for a printable-card download, kept for a short while so each zip can be fetched by its part number
 * (a selection of hundreds of guests does not fit in a web address). Removed automatically when it expires.
 */
export interface ICardDownloadPlan extends Document {
  eventId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  inviteeIds: mongoose.Types.ObjectId[];
  /** the session the list was filtered to when the download was started (absent = all sessions); it names the zip files */
  sessionId?: mongoose.Types.ObjectId | null;
  expiresAt: Date;
}

const CardDownloadPlanSchema = new Schema<ICardDownloadPlan>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  inviteeIds: [{ type: Schema.Types.ObjectId }],
  sessionId: { type: Schema.Types.ObjectId, default: null },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
});

export const CardDownloadPlan = mongoose.model<ICardDownloadPlan>('CardDownloadPlan', CardDownloadPlanSchema);
