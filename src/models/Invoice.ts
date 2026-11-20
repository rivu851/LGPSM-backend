import mongoose, { Document, Schema } from 'mongoose';

export interface IInvoice extends Document {
  invoiceNumber: string;
  paymentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  eventId: mongoose.Types.ObjectId;
  /** invitations the payment covers (event bills) */
  invitees?: number;
  subtotal: number;
  tax: number;
  total: number;
  paymentMethod: string;
  paymentStatus: string;
  issuedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceSchema: Schema = new Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    invitees: { type: Number },
    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMethod: { type: String, default: 'RAZORPAY' },
    paymentStatus: { type: String, default: 'PAID' },
    issuedAt: { type: Date, default: Date.now }
  },
  {
    timestamps: true
  }
);

InvoiceSchema.index({ paymentId: 1 });
InvoiceSchema.index({ userId: 1 });

export const Invoice = mongoose.model<IInvoice>('Invoice', InvoiceSchema);
