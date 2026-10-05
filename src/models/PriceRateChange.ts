import mongoose, { Document, Schema } from 'mongoose';

// Audit trail of per-invitee rate changes. A change applies to events created after it;
// existing events keep the rate locked on them at creation.
export interface IPriceRateChange extends Document {
  previousRate: number | null;
  newRate: number;
  currency: string;
  changedBy: mongoose.Types.ObjectId;
  createdAt: Date;
}

const PriceRateChangeSchema = new Schema<IPriceRateChange>(
  {
    previousRate: { type: Number, default: null },
    newRate: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PriceRateChangeSchema.index({ createdAt: -1 });

export const PriceRateChange = mongoose.model<IPriceRateChange>('PriceRateChange', PriceRateChangeSchema);
