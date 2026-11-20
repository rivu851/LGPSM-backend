import mongoose, { Document, Schema } from 'mongoose';

export enum OrderStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED'
}

export interface IOrder extends Document {
  userId: mongoose.Types.ObjectId;
  eventId: mongoose.Types.ObjectId;
  /** TICKET: a guest buying a ticket tier. EVENT_BILL: an organizer paying for the invitations sent for an event. */
  kind: 'TICKET' | 'EVENT_BILL';
  ticketTierId?: mongoose.Types.ObjectId;
  /** EVENT_BILL: how many invitations this payment covers */
  invitees?: number;
  quantity: number;
  amount: number;
  currency: string;
  providerOrderId?: string;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema: Schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    kind: { type: String, enum: ['TICKET', 'EVENT_BILL'], default: 'TICKET' },
    ticketTierId: { type: Schema.Types.ObjectId, ref: 'TicketTier' },
    invitees: { type: Number, min: 0 },
    quantity: { type: Number, default: 1, min: 1 },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    providerOrderId: { type: String },
    status: { type: String, enum: Object.values(OrderStatus), default: OrderStatus.PENDING }
  },
  {
    timestamps: true
  }
);

OrderSchema.index({ userId: 1 });
OrderSchema.index({ eventId: 1 });
OrderSchema.index({ providerOrderId: 1 });

export const Order = mongoose.model<IOrder>('Order', OrderSchema);
