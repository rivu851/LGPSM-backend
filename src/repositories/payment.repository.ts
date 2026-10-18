import { Payment, IPayment, PaymentStatus } from '../models/Payment';

export const paymentRepository = {
  async create(data: Partial<IPayment>): Promise<IPayment> {
    return await Payment.create(data);
  },

  async findByOrderId(orderId: string): Promise<IPayment | null> {
    return await Payment.findOne({ orderId });
  },

  async findByProviderOrderId(providerOrderId: string): Promise<IPayment | null> {
    return await Payment.findOne({ providerOrderId });
  },

  async updatePaymentStatus(providerOrderId: string, status: string, providerPaymentId?: string, signatureVerified?: boolean): Promise<IPayment | null> {
    const update: any = { status };
    if (providerPaymentId) update.providerPaymentId = providerPaymentId;
    if (signatureVerified !== undefined) update.signatureVerified = signatureVerified;

    return await Payment.findOneAndUpdate({ providerOrderId }, update, { new: true });
  },

  // Atomically moves a payment to PAID. Returns the payment only for the call that made the
  // transition, so retries and concurrent webhook/browser confirmations cannot settle it twice.
  async claimPaid(providerOrderId: string, providerPaymentId: string): Promise<IPayment | null> {
    return await Payment.findOneAndUpdate(
      { providerOrderId, status: { $ne: PaymentStatus.PAID } },
      { status: PaymentStatus.PAID, providerPaymentId, signatureVerified: true },
      { new: true }
    );
  },

  // Records a failure, but never downgrades a payment that has already been settled.
  async claimFailed(providerOrderId: string, providerPaymentId?: string): Promise<IPayment | null> {
    return await Payment.findOneAndUpdate(
      { providerOrderId, status: { $ne: PaymentStatus.PAID } },
      { status: PaymentStatus.FAILED, signatureVerified: false, ...(providerPaymentId ? { providerPaymentId } : {}) },
      { new: true }
    );
  }
};
