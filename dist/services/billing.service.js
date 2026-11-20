"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.billingService = void 0;
exports.priceFor = priceFor;
const mongoose_1 = __importDefault(require("mongoose"));
const Event_1 = require("../models/Event");
const Invitee_1 = require("../models/Invitee");
const Order_1 = require("../models/Order");
const Payment_1 = require("../models/Payment");
const Invoice_1 = require("../models/Invoice");
const currency_1 = require("../constants/currency");
const order_repository_1 = require("../repositories/order.repository");
const payment_repository_1 = require("../repositories/payment.repository");
const platformSettings_service_1 = require("./platformSettings.service");
const payment_service_1 = require("./payment.service");
const round2 = (n) => Math.round(n * 100) / 100;
// The charge is per invitation: invitations x the rate locked on the event, plus GST at the platform's current percentage.
// Payments are counted in invitations (not rupees) so a changing GST never makes old payments look short or over:
//   covered = invitations already paid for;  sent = invitations actually sent.
// Invitations paid for but not sent yet are credit that the next send uses up (e.g. a send that partly failed).
async function eventState(event) {
    const locked = event.pricing && event.pricing.lockedAt;
    // The charge per invitee: the rate an administrator set for this organizer when there is one; otherwise the rate locked on the event;
    // and when the event has none, the platform rate the administrator has set (Settings > Price Rate), which is then kept on the event.
    const custom = await platformSettings_service_1.platformSettingsService.customRateOf(event.organizerId);
    let rate = custom ?? (locked ? event.pricing.ratePerInvitee ?? null : await platformSettings_service_1.platformSettingsService.rateInEffectAt(new Date(event.createdAt)));
    // An event created before the admin set a per-head rate has none stored. Billing then uses the admin's current rate and stores
    // it on the event (so the figure stays the same from now on and matches the earnings view); with no rate set anywhere it is free.
    if (!(rate && rate > 0)) {
        const current = await platformSettings_service_1.platformSettingsService.currentRateSnapshot();
        if (current.ratePerInvitee && current.ratePerInvitee > 0) {
            rate = current.ratePerInvitee;
            await Event_1.Event.updateOne({ _id: event._id, $or: [{ 'pricing.ratePerInvitee': null }, { 'pricing.ratePerInvitee': { $exists: false } }, { 'pricing.ratePerInvitee': 0 }] }, { $set: { pricing: current } });
        }
    }
    const sent = await Invitee_1.Invitee.countDocuments({ eventId: event._id, invitationStatus: Invitee_1.InvitationStatus.SENT });
    const paid = await Order_1.Order.aggregate([
        { $match: { eventId: event._id, kind: 'EVENT_BILL', status: Order_1.OrderStatus.PAID } },
        { $group: { _id: null, amount: { $sum: '$amount' }, invitees: { $sum: '$invitees' } } }
    ]);
    const covered = paid[0]?.invitees || 0;
    return { rate: rate && rate > 0 ? rate : null, sent, covered, paidAmount: round2(paid[0]?.amount || 0) };
}
function priceFor(invitees, rate, gstPercent) {
    const subtotal = round2(invitees * rate);
    const tax = round2((subtotal * gstPercent) / 100);
    return { invitees, rate, subtotal, gstPercent, tax, total: round2(subtotal + tax), currency: currency_1.PLATFORM_CURRENCY };
}
async function eventBill(event, gstPercent) {
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
        currency: currency_1.PLATFORM_CURRENCY
    };
}
// How many of the chosen guests would be newly billed: only guests not yet sent count, and invitations already paid for are used first
async function billableFor(event, inviteeIds) {
    const st = await eventState(event);
    const toSend = await Invitee_1.Invitee.countDocuments({
        eventId: event._id,
        _id: { $in: inviteeIds },
        invitationStatus: { $ne: Invitee_1.InvitationStatus.SENT }
    });
    const credit = Math.max(0, st.covered - st.sent);
    return { rate: st.rate, toSend, credit, billable: Math.max(0, toSend - credit) };
}
exports.billingService = {
    /** The organizer's events with what is billed, paid and due for each. */
    async listEventBills(organizerId) {
        const gst = await platformSettings_service_1.platformSettingsService.gstPercent();
        const events = await Event_1.Event.find({ organizerId, status: { $ne: 'CANCELLED' } })
            .select('title schedule createdAt pricing organizerId')
            .sort({ 'schedule.start': -1 })
            .lean();
        const rows = [];
        for (const e of events)
            rows.push(await eventBill(e, gst));
        const shown = rows.filter((r) => r.invitesSent > 0 || r.paid > 0);
        return {
            currency: currency_1.PLATFORM_CURRENCY,
            gstPercent: gst,
            totalDue: round2(shown.reduce((s, r) => s + r.due, 0)),
            totalPaid: round2(shown.reduce((s, r) => s + r.paid, 0)),
            events: shown
        };
    },
    /** The bill for sending to the chosen guests: invitations x rate, GST, total. Nothing is created. */
    async quote(organizerId, eventId, inviteeIds) {
        const event = await Event_1.Event.findOne({ _id: eventId, organizerId }).lean();
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        const gst = await platformSettings_service_1.platformSettingsService.gstPercent();
        const b = await billableFor(event, inviteeIds);
        const price = priceFor(b.billable, b.rate ?? 0, gst);
        return { ...price, rate: b.rate, selected: b.toSend, alreadyPaid: Math.min(b.toSend, b.credit), payable: b.rate !== null && b.billable > 0 };
    },
    /**
     * Creates the Razorpay order. With `inviteeIds` it is the bill for sending to those guests; without, it is whatever is
     * due for invitations already sent on the event.
     */
    async createBillOrder(organizerId, eventId, inviteeIds) {
        const event = await Event_1.Event.findOne({ _id: eventId, organizerId }).lean();
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        const gst = await platformSettings_service_1.platformSettingsService.gstPercent();
        let count;
        let rate;
        if (inviteeIds && inviteeIds.length) {
            const b = await billableFor(event, inviteeIds);
            count = b.billable;
            rate = b.rate;
        }
        else {
            const st = await eventState(event);
            rate = st.rate;
            count = st.rate ? Math.max(0, st.sent - st.covered) : 0;
        }
        if (rate === null)
            throw new Error('RATE_NOT_SET');
        if (count <= 0)
            throw new Error('NOTHING_DUE');
        const price = priceFor(count, rate, gst);
        if (price.total <= 0)
            throw new Error('NOTHING_DUE');
        const { keyId } = (0, payment_service_1.getRazorpayCredentials)();
        const rzp = await (0, payment_service_1.createRazorpayOrder)(Math.round(price.total * 100), currency_1.PLATFORM_CURRENCY, `bill_${String(event._id).slice(-8)}_${Date.now()}`);
        const providerOrderId = rzp.id;
        const order = await order_repository_1.orderRepository.create({
            kind: 'EVENT_BILL',
            userId: organizerId,
            eventId: event._id,
            quantity: 1,
            invitees: count,
            amount: price.total,
            subtotal: price.subtotal,
            tax: price.tax,
            gstPercent: gst,
            currency: currency_1.PLATFORM_CURRENCY,
            providerOrderId,
            status: Order_1.OrderStatus.PENDING
        });
        await payment_repository_1.paymentRepository.create({
            orderId: order._id,
            userId: organizerId,
            eventId: event._id,
            provider: 'RAZORPAY',
            providerOrderId,
            amountBase: price.subtotal,
            taxAmount: price.tax,
            totalAmount: price.total,
            currency: currency_1.PLATFORM_CURRENCY,
            status: Payment_1.PaymentStatus.CREATED,
            signatureVerified: false
        });
        return {
            keyId,
            providerOrderId,
            amount: rzp.amount,
            eventId: String(event._id),
            eventName: event.title,
            ...price
        };
    },
    /** The organizer's paid invoices, shaped for the Billing list and statement. */
    async listInvoices(organizerId) {
        const invoices = await Invoice_1.Invoice.find({ userId: new mongoose_1.default.Types.ObjectId(organizerId) }).populate('eventId', 'title').sort({ issuedAt: -1 }).lean();
        return invoices.map((i) => ({
            id: String(i._id),
            invoiceId: i.invoiceNumber,
            eventName: i.eventId?.title || 'Event',
            invitees: i.invitees ?? 0,
            paymentDate: new Date(i.issuedAt).toISOString(),
            subtotal: i.subtotal,
            tax: i.tax,
            amount: i.total,
            currency: currency_1.PLATFORM_CURRENCY
        }));
    }
};
