"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentRepository = void 0;
const Payment_1 = require("../models/Payment");
exports.paymentRepository = {
    async create(data) {
        return await Payment_1.Payment.create(data);
    },
    async findByOrderId(orderId) {
        return await Payment_1.Payment.findOne({ orderId });
    },
    async findByProviderOrderId(providerOrderId) {
        return await Payment_1.Payment.findOne({ providerOrderId });
    },
    async updatePaymentStatus(providerOrderId, status, providerPaymentId, signatureVerified) {
        const update = { status };
        if (providerPaymentId)
            update.providerPaymentId = providerPaymentId;
        if (signatureVerified !== undefined)
            update.signatureVerified = signatureVerified;
        return await Payment_1.Payment.findOneAndUpdate({ providerOrderId }, update, { new: true });
    },
    // Atomically moves a payment to PAID. Returns the payment only for the call that made the
    // transition, so retries and concurrent webhook/browser confirmations cannot settle it twice.
    async claimPaid(providerOrderId, providerPaymentId) {
        return await Payment_1.Payment.findOneAndUpdate({ providerOrderId, status: { $ne: Payment_1.PaymentStatus.PAID } }, { status: Payment_1.PaymentStatus.PAID, providerPaymentId, signatureVerified: true }, { new: true });
    },
    // Records a failure, but never downgrades a payment that has already been settled.
    async claimFailed(providerOrderId, providerPaymentId) {
        return await Payment_1.Payment.findOneAndUpdate({ providerOrderId, status: { $ne: Payment_1.PaymentStatus.PAID } }, { status: Payment_1.PaymentStatus.FAILED, signatureVerified: false, ...(providerPaymentId ? { providerPaymentId } : {}) }, { new: true });
    }
};
