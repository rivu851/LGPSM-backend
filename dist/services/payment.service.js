"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const order_repository_1 = require("../repositories/order.repository");
const payment_repository_1 = require("../repositories/payment.repository");
const invoice_repository_1 = require("../repositories/invoice.repository");
const TicketTier_1 = require("../models/TicketTier");
const Event_1 = require("../models/Event");
const Order_1 = require("../models/Order");
const Payment_1 = require("../models/Payment");
// Payments fail closed: nothing is marked PAID unless Razorpay is configured and the signature verifies.
function getRazorpayCredentials() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
        throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
    }
    return { keyId, keySecret };
}
async function createRazorpayOrder(amountInPaise, currency, receipt) {
    const { keyId, keySecret } = getRazorpayCredentials();
    const response = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
        },
        body: JSON.stringify({ amount: amountInPaise, currency, receipt })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.id) {
        throw new Error('PAYMENT_PROVIDER_ERROR');
    }
    return data;
}
// Constant-time comparison of two hex digests (different lengths simply do not match)
function safeEqualHex(expected, provided) {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(provided), 'utf8');
    return a.length === b.length && crypto_1.default.timingSafeEqual(a, b);
}
// Settles a payment exactly once. Only the call that actually flips the payment to PAID updates the
// order, the tier's sold count and the invoice, so replays and concurrent confirmations are no-ops.
async function settlePaid(providerOrderId, providerPaymentId) {
    const payment = await payment_repository_1.paymentRepository.claimPaid(providerOrderId, providerPaymentId);
    if (!payment)
        return;
    const order = await order_repository_1.orderRepository.updateStatus(payment.orderId.toString(), Order_1.OrderStatus.PAID);
    if (order) {
        await TicketTier_1.TicketTier.findByIdAndUpdate(order.ticketTierId, { $inc: { sold: order.quantity } });
    }
    const existing = await invoice_repository_1.invoiceRepository.findByPaymentId(payment._id.toString());
    if (!existing) {
        await invoice_repository_1.invoiceRepository.create({
            invoiceNumber: `INV-${Date.now()}-${crypto_1.default.randomInt(1000, 10000)}`,
            paymentId: payment._id,
            userId: payment.userId,
            eventId: payment.eventId,
            subtotal: payment.amountBase,
            tax: payment.taxAmount,
            total: payment.totalAmount,
            paymentMethod: 'RAZORPAY',
            paymentStatus: 'PAID',
            issuedAt: new Date()
        });
    }
}
exports.paymentService = {
    async createTicketOrder(userId, eventId, ticketTierId, quantity) {
        const event = await Event_1.Event.findById(eventId);
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        const tier = await TicketTier_1.TicketTier.findOne({ _id: ticketTierId, eventId, isActive: true });
        if (!tier)
            throw new Error('TICKET_TIER_NOT_FOUND');
        if (tier.sold + quantity > tier.capacity) {
            throw new Error('TIER_CAPACITY_EXCEEDED');
        }
        const totalAmount = tier.price * quantity;
        const currency = tier.currency || 'INR';
        // Order must exist at the provider before we record anything locally
        getRazorpayCredentials();
        const receipt = `rcpt_${Date.now()}`;
        const razorpayOrder = await createRazorpayOrder(Math.round(totalAmount * 100), currency, receipt);
        const providerOrderId = razorpayOrder.id;
        const order = await order_repository_1.orderRepository.create({
            userId: userId,
            eventId: eventId,
            ticketTierId: ticketTierId,
            quantity,
            amount: totalAmount,
            currency,
            providerOrderId,
            status: Order_1.OrderStatus.PENDING
        });
        const payment = await payment_repository_1.paymentRepository.create({
            orderId: order._id,
            userId: userId,
            eventId: eventId,
            provider: 'RAZORPAY',
            providerOrderId,
            amountBase: totalAmount,
            taxAmount: 0,
            totalAmount,
            currency,
            status: Payment_1.PaymentStatus.CREATED,
            signatureVerified: false
        });
        return {
            order,
            payment,
            razorpayOrder: {
                id: providerOrderId,
                entity: razorpayOrder.entity,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency,
                receipt: razorpayOrder.receipt
            }
        };
    },
    async verifyPayment(userId, providerOrderId, providerPaymentId, signature) {
        const { keySecret } = getRazorpayCredentials();
        const payment = await payment_repository_1.paymentRepository.findByProviderOrderId(providerOrderId);
        if (!payment || payment.userId.toString() !== userId)
            throw new Error('PAYMENT_NOT_FOUND');
        const expected = crypto_1.default.createHmac('sha256', keySecret).update(`${providerOrderId}|${providerPaymentId}`).digest('hex');
        const isValid = !!signature && safeEqualHex(expected, signature);
        if (!isValid) {
            // A bad signature can fail a pending payment but must never undo one that is already settled
            const failed = await payment_repository_1.paymentRepository.claimFailed(providerOrderId, providerPaymentId);
            if (failed)
                await order_repository_1.orderRepository.updateStatus(payment.orderId.toString(), Order_1.OrderStatus.FAILED);
            throw new Error('INVALID_PAYMENT_SIGNATURE');
        }
        await settlePaid(providerOrderId, providerPaymentId);
        const current = await payment_repository_1.paymentRepository.findByProviderOrderId(providerOrderId);
        const order = await order_repository_1.orderRepository.findById(payment.orderId.toString());
        const invoice = current ? await invoice_repository_1.invoiceRepository.findByPaymentId(current._id.toString()) : null;
        return { order, payment: current, invoice };
    },
    // `rawBody` is the exact bytes Razorpay sent: the signature is computed over those, not over a
    // re-serialised copy, which can differ in whitespace, key order and escaping.
    async handleWebhook(rawBody, signature) {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!webhookSecret) {
            throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
        }
        if (!signature || !rawBody) {
            throw new Error('INVALID_WEBHOOK_SIGNATURE');
        }
        const expectedSignature = crypto_1.default.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
        if (!safeEqualHex(expectedSignature, signature)) {
            throw new Error('INVALID_WEBHOOK_SIGNATURE');
        }
        let eventBody;
        try {
            eventBody = JSON.parse(rawBody.toString('utf8'));
        }
        catch {
            throw new Error('INVALID_WEBHOOK_SIGNATURE');
        }
        const eventName = eventBody.event;
        const paymentEntity = eventBody.payload?.payment?.entity;
        if (!paymentEntity)
            return { success: true, message: 'Ignored non-payment event' };
        const providerOrderId = paymentEntity.order_id;
        const providerPaymentId = paymentEntity.id;
        if (eventName === 'payment.captured' || eventName === 'order.paid') {
            await settlePaid(providerOrderId, providerPaymentId);
        }
        else if (eventName === 'payment.failed') {
            const failed = await payment_repository_1.paymentRepository.claimFailed(providerOrderId, providerPaymentId);
            if (failed)
                await order_repository_1.orderRepository.updateStatus(failed.orderId.toString(), Order_1.OrderStatus.FAILED);
        }
        return { success: true, event: eventName };
    },
    async getUserOrders(userId, page = 1, limit = 20) {
        return await order_repository_1.orderRepository.findByUserId(userId, page, limit);
    },
    async getOrderById(orderId, userId) {
        const order = await order_repository_1.orderRepository.findById(orderId);
        if (!order || order.userId.toString() !== userId)
            throw new Error('ORDER_NOT_FOUND');
        return order;
    },
    async getInvoiceById(invoiceId, userId) {
        const invoice = await invoice_repository_1.invoiceRepository.findById(invoiceId);
        if (!invoice || invoice.userId.toString() !== userId)
            throw new Error('INVOICE_NOT_FOUND');
        return invoice;
    }
};
