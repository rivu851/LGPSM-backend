"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.billingService = void 0;
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
// What an organizer owes for an event: the invitations sent x the rate locked on the event (the same figure the admin's earnings
// view uses), minus what was already paid. Sending more invitations later raises the bill; paying settles what is due at that moment.
async function eventBill(event) {
    const locked = event.pricing && event.pricing.lockedAt;
    const rate = locked ? event.pricing.ratePerInvitee ?? null : await platformSettings_service_1.platformSettingsService.rateInEffectAt(new Date(event.createdAt));
    const sent = await Invitee_1.Invitee.countDocuments({ eventId: event._id, invitationStatus: Invitee_1.InvitationStatus.SENT });
    const paid = await Order_1.Order.aggregate([
        { $match: { eventId: event._id, kind: 'EVENT_BILL', status: Order_1.OrderStatus.PAID } },
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
        currency: currency_1.PLATFORM_CURRENCY
    };
}
exports.billingService = {
    /** The organizer's events with what is billed, paid and due for each. */
    async listEventBills(organizerId) {
        const events = await Event_1.Event.find({ organizerId, status: { $ne: 'CANCELLED' } })
            .select('title schedule createdAt pricing')
            .sort({ 'schedule.start': -1 })
            .lean();
        const rows = [];
        for (const e of events)
            rows.push(await eventBill(e));
        const shown = rows.filter((r) => r.invitesSent > 0 || r.paid > 0);
        return {
            currency: currency_1.PLATFORM_CURRENCY,
            totalDue: round2(shown.reduce((s, r) => s + r.due, 0)),
            totalPaid: round2(shown.reduce((s, r) => s + r.paid, 0)),
            events: shown
        };
    },
    /** Creates the Razorpay order for everything currently due on one of the organizer's events. */
    async createBillOrder(organizerId, eventId) {
        const event = await Event_1.Event.findOne({ _id: eventId, organizerId }).lean();
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        const bill = await eventBill(event);
        if (bill.ratePerInvitee === null || !(bill.ratePerInvitee > 0))
            throw new Error('RATE_NOT_SET');
        if (bill.due <= 0)
            throw new Error('NOTHING_DUE');
        const { keyId } = (0, payment_service_1.getRazorpayCredentials)();
        const rzp = await (0, payment_service_1.createRazorpayOrder)(Math.round(bill.due * 100), currency_1.PLATFORM_CURRENCY, `bill_${String(event._id).slice(-8)}_${Date.now()}`);
        const providerOrderId = rzp.id;
        const order = await order_repository_1.orderRepository.create({
            kind: 'EVENT_BILL',
            userId: organizerId,
            eventId: event._id,
            quantity: 1,
            invitees: bill.dueInvitees,
            amount: bill.due,
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
            amountBase: bill.due,
            taxAmount: 0,
            totalAmount: bill.due,
            currency: currency_1.PLATFORM_CURRENCY,
            status: Payment_1.PaymentStatus.CREATED,
            signatureVerified: false
        });
        return {
            keyId,
            providerOrderId,
            amount: rzp.amount,
            currency: currency_1.PLATFORM_CURRENCY,
            eventId: bill.eventId,
            eventName: bill.eventName,
            invitees: bill.dueInvitees
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
            amount: i.total,
            currency: currency_1.PLATFORM_CURRENCY
        }));
    }
};
