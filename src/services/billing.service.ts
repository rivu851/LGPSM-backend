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

// The charge is per invitation: invitations x the rate locked on the event, plus GST at the platform's current percentage.
// Payments are counted in invitations (not rupees) so a changing GST never makes old payments look short or over:
//   covered = invitations already paid for;  sent = invitations actually sent.
// Invitations paid for but not sent yet are credit that the next send uses up (e.g. a send that partly failed).
async function eventState(event: any) {
  const locked = event.pricing && event.pricing.lockedAt;
  const rate: number | null = locked ? event.pricing.ratePerInvitee ?? null : await platformSettingsService.rateInEffectAt(new Date(event.createdAt));
  const sent = await Invitee.countDocuments({ eventId: event._id, invitationStatus: InvitationStatus.SENT });
  const paid = await Order.aggregate([
    { $match: { eventId: event._id, kind: 'EVENT_BILL', status: OrderStatus.PAID } },
    { $group: { _id: null, amount: { $sum: '$amount' }, invitees: { $sum: '$invitees' } } }
  ]);
  const covered: number = paid[0]?.invitees || 0;
  return { rate: rate && rate > 0 ? rate : null, sent, covered, paidAmount: round2(paid[0]?.amount || 0) };
}

export function priceFor(invitees: number, rate: number, gstPercent: number) {
  const subtotal = round2(invitees * rate);
  const tax = round2((subtotal * gstPercent) / 100);
  return { invitees, rate, subtotal, gstPercent, tax, total: round2(subtotal + tax), currency: PLATFORM_CURRENCY };
}

async function eventBill(event: any, gstPercent: number) {
  const st = await eventState(event);
  const dueInvitees = st.rate ? Math.max(0, st.sent - st.covered) : 0;
  const due = st.rate ? priceFor(dueInvitees, st.rate, gstPercent) : null;
  return {
    eventId: String(event._id),
    eventName: event.title,
    eventStart: event.schedule?.start,
    invitesSent: st.sent,
    ratePerInvitee: st.rate,
    gstPercent,
    paid: st.paidAmount,
    dueInvitees,
    dueSubtotal: due?.subtotal ?? 0,
    dueTax: due?.tax ?? 0,
    due: due?.total ?? 0,
    currency: PLATFORM_CURRENCY
  };
}

// How many of the chosen guests would be newly billed: only guests not yet sent count, and invitations already paid for are used first
async function billableFor(event: any, inviteeIds: string[]) {
  const st = await eventState(event);
  const toSend = await Invitee.countDocuments({
    eventId: event._id,
    _id: { $in: inviteeIds },
    invitationStatus: { $ne: InvitationStatus.SENT }
  });
  const credit = Math.max(0, st.covered - st.sent);
  return { rate: st.rate, toSend, credit, billable: Math.max(0, toSend - credit) };
}

export const billingService = {
  /** The organizer's events with what is billed, paid and due for each. */
  async listEventBills(organizerId: string) {
    const gst = await platformSettingsService.gstPercent();
    const events = await Event.find({ organizerId, status: { $ne: 'CANCELLED' } })
      .select('title schedule createdAt pricing')
      .sort({ 'schedule.start': -1 })
      .lean();
    const rows = [];
    for (const e of events) rows.push(await eventBill(e, gst));
    const shown = rows.filter((r) => r.invitesSent > 0 || r.paid > 0);
    return {
      currency: PLATFORM_CURRENCY,
      gstPercent: gst,
      totalDue: round2(shown.reduce((s, r) => s + r.due, 0)),
      totalPaid: round2(shown.reduce((s, r) => s + r.paid, 0)),
      events: shown
    };
  },

  /** The bill for sending to the chosen guests: invitations x rate, GST, total. Nothing is created. */
  async quote(organizerId: string, eventId: string, inviteeIds: string[]) {
    const event: any = await Event.findOne({ _id: eventId, organizerId }).lean();
    if (!event) throw new Error('EVENT_NOT_FOUND');
    const gst = await platformSettingsService.gstPercent();
    const b = await billableFor(event, inviteeIds);
    const price = priceFor(b.billable, b.rate ?? 0, gst);
    return { ...price, rate: b.rate, selected: b.toSend, alreadyPaid: Math.min(b.toSend, b.credit), payable: b.rate !== null && b.billable > 0 };
  },

  /**
   * Creates the Razorpay order. With `inviteeIds` it is the bill for sending to those guests; without, it is whatever is
   * due for invitations already sent on the event.
   */
  async createBillOrder(organizerId: string, eventId: string, inviteeIds?: string[]) {
    const event: any = await Event.findOne({ _id: eventId, organizerId }).lean();
    if (!event) throw new Error('EVENT_NOT_FOUND');
    const gst = await platformSettingsService.gstPercent();

    let count: number;
    let rate: number | null;
    if (inviteeIds && inviteeIds.length) {
      const b = await billableFor(event, inviteeIds);
      count = b.billable;
      rate = b.rate;
    } else {
      const st = await eventState(event);
      rate = st.rate;
      count = st.rate ? Math.max(0, st.sent - st.covered) : 0;
    }
    if (rate === null) throw new Error('RATE_NOT_SET');
    if (count <= 0) throw new Error('NOTHING_DUE');
    const price = priceFor(count, rate, gst);
    if (price.total <= 0) throw new Error('NOTHING_DUE');

    const { keyId } = getRazorpayCredentials();
    const rzp = await createRazorpayOrder(Math.round(price.total * 100), PLATFORM_CURRENCY, `bill_${String(event._id).slice(-8)}_${Date.now()}`);
    const providerOrderId: string = rzp.id;

    const order = await orderRepository.create({
      kind: 'EVENT_BILL',
      userId: organizerId as any,
      eventId: event._id,
      quantity: 1,
      invitees: count,
      amount: price.total,
      subtotal: price.subtotal,
      tax: price.tax,
      gstPercent: gst,
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
      amountBase: price.subtotal,
      taxAmount: price.tax,
      totalAmount: price.total,
      currency: PLATFORM_CURRENCY,
      status: PaymentStatus.CREATED,
      signatureVerified: false
    });

    return {
      keyId,
      providerOrderId,
      amount: rzp.amount as number,
      eventId: String(event._id),
      eventName: event.title,
      ...price
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
      subtotal: i.subtotal,
      tax: i.tax,
      amount: i.total,
      currency: PLATFORM_CURRENCY
    }));
  }
};
