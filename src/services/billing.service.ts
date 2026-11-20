import mongoose from 'mongoose';
import { Event } from '../models/Event';
import { Invitee, InvitationStatus } from '../models/Invitee';
import { Order, OrderStatus } from '../models/Order';
import { PaymentStatus } from '../models/Payment';
import { Invoice } from '../models/Invoice';
import { PLATFORM_CURRENCY } from '../constants/currency';
import { orderRepository } from '../repositories/order.repository';
import { paymentRepository } from '../repositories/payment.repository';
import { platformSettingsService } from './platformSettings.service';
import { createRazorpayOrder, getRazorpayCredentials } from './payment.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

// What an organizer owes for an event: the invitations sent x the rate locked on the event (the same figure the admin's earnings
// view uses), minus what was already paid. Sending more invitations later raises the bill; paying settles what is due at that moment.
async function eventBill(event: any) {
  const locked = event.pricing && event.pricing.lockedAt;
  const rate: number | null = locked ? event.pricing.ratePerInvitee ?? null : await platformSettingsService.rateInEffectAt(new Date(event.createdAt));
  const sent = await Invitee.countDocuments({ eventId: event._id, invitationStatus: InvitationStatus.SENT });
  const paid = await Order.aggregate([
    { $match: { eventId: event._id, kind: 'EVENT_BILL', status: OrderStatus.PAID } },
    { $group: { _id: null, amount: { $sum: '$amount' }, invitees: { $sum: '$invitees' } } }
  ]);
  const paidAmount = paid[0]?.amount || 0;
  const paidInvitees = paid[0]?.invitees || 0;
  const billed = rate && rate > 0 ? round2(sent * rate) : 0;
  const due = Math.max(0, round2(billed - paidAmount));
  const dueInvitees = rate && rate > 0 ? Math.max(0, sent - paidInvitees) : 0;
  return {
    eventId: String(event._id),
    eventName: event.title,
    eventStart: event.schedule?.start,
    invitesSent: sent,
    ratePerInvitee: rate,
    billed,
    paid: round2(paidAmount),
    due,
    dueInvitees,
    currency: PLATFORM_CURRENCY
  };
}

export const billingService = {
  /** The organizer's events with what is billed, paid and due for each. */
  async listEventBills(organizerId: string) {
    const events = await Event.find({ organizerId, status: { $ne: 'CANCELLED' } })
      .select('title schedule createdAt pricing')
      .sort({ 'schedule.start': -1 })
      .lean();
    const rows = [];
    for (const e of events) rows.push(await eventBill(e));
    const shown = rows.filter((r) => r.invitesSent > 0 || r.paid > 0);
    return {
      currency: PLATFORM_CURRENCY,
      totalDue: round2(shown.reduce((s, r) => s + r.due, 0)),
      totalPaid: round2(shown.reduce((s, r) => s + r.paid, 0)),
      events: shown
    };
  },

  /** Creates the Razorpay order for everything currently due on one of the organizer's events. */
  async createBillOrder(organizerId: string, eventId: string) {
    const event: any = await Event.findOne({ _id: eventId, organizerId }).lean();
    if (!event) throw new Error('EVENT_NOT_FOUND');
    const bill = await eventBill(event);
    if (bill.ratePerInvitee === null || !(bill.ratePerInvitee > 0)) throw new Error('RATE_NOT_SET');
    if (bill.due <= 0) throw new Error('NOTHING_DUE');

    const { keyId } = getRazorpayCredentials();
    const rzp = await createRazorpayOrder(Math.round(bill.due * 100), PLATFORM_CURRENCY, `bill_${String(event._id).slice(-8)}_${Date.now()}`);
    const providerOrderId: string = rzp.id;

    const order = await orderRepository.create({
      kind: 'EVENT_BILL',
      userId: organizerId as any,
      eventId: event._id,
      quantity: 1,
      invitees: bill.dueInvitees,
      amount: bill.due,
      currency: PLATFORM_CURRENCY,
      providerOrderId,
      status: OrderStatus.PENDING
    } as any);
    await paymentRepository.create({
      orderId: order._id as any,
      userId: organizerId as any,
      eventId: event._id,
      provider: 'RAZORPAY',
      providerOrderId,
      amountBase: bill.due,
      taxAmount: 0,
      totalAmount: bill.due,
      currency: PLATFORM_CURRENCY,
      status: PaymentStatus.CREATED,
      signatureVerified: false
    });

    return {
      keyId,
      providerOrderId,
      amount: rzp.amount as number,
      currency: PLATFORM_CURRENCY,
      eventId: bill.eventId,
      eventName: bill.eventName,
      invitees: bill.dueInvitees
    };
  },

  /** The organizer's paid invoices, shaped for the Billing list and statement. */
  async listInvoices(organizerId: string) {
    const invoices = await Invoice.find({ userId: new mongoose.Types.ObjectId(organizerId) }).populate('eventId', 'title').sort({ issuedAt: -1 }).lean();
    return invoices.map((i: any) => ({
      id: String(i._id),
      invoiceId: i.invoiceNumber,
      eventName: i.eventId?.title || 'Event',
      invitees: i.invitees ?? 0,
      paymentDate: new Date(i.issuedAt).toISOString(),
      amount: i.total,
      currency: PLATFORM_CURRENCY
    }));
  }
};
