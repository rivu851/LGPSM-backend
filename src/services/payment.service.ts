import crypto from 'crypto';
import { orderRepository } from '../repositories/order.repository';
import { paymentRepository } from '../repositories/payment.repository';
import { invoiceRepository } from '../repositories/invoice.repository';
import { TicketTier } from '../models/TicketTier';
import { Event } from '../models/Event';
import { OrderStatus } from '../models/Order';
import { PaymentStatus } from '../models/Payment';

// Payments fail closed: nothing is marked PAID unless Razorpay is configured and the signature verifies.
function getRazorpayCredentials() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
  }
  return { keyId, keySecret };
}

async function createRazorpayOrder(amountInPaise: number, currency: string, receipt: string) {
  const { keyId, keySecret } = getRazorpayCredentials();
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
    },
    body: JSON.stringify({ amount: amountInPaise, currency, receipt })
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id) {
    throw new Error('PAYMENT_PROVIDER_ERROR');
  }
  return data;
}

// Constant-time comparison of two hex digests (different lengths simply do not match)
function safeEqualHex(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Settles a payment exactly once. Only the call that actually flips the payment to PAID updates the
// order, the tier's sold count and the invoice, so replays and concurrent confirmations are no-ops.
async function settlePaid(providerOrderId: string, providerPaymentId: string): Promise<void> {
  const payment = await paymentRepository.claimPaid(providerOrderId, providerPaymentId);
  if (!payment) return;

  const order = await orderRepository.updateStatus((payment.orderId as any).toString(), OrderStatus.PAID);
  if (order) {
    await TicketTier.findByIdAndUpdate(order.ticketTierId, { $inc: { sold: order.quantity } });
  }

  const existing = await invoiceRepository.findByPaymentId((payment._id as any).toString());
  if (!existing) {
    await invoiceRepository.create({
      invoiceNumber: `INV-${Date.now()}-${crypto.randomInt(1000, 10000)}`,
      paymentId: payment._id as any,
      userId: payment.userId as any,
      eventId: payment.eventId as any,
      subtotal: payment.amountBase,
      tax: payment.taxAmount,
      total: payment.totalAmount,
      paymentMethod: 'RAZORPAY',
      paymentStatus: 'PAID',
      issuedAt: new Date()
    });
  }
}

export const paymentService = {
  async createTicketOrder(userId: string, eventId: string, ticketTierId: string, quantity: number) {
    const event = await Event.findById(eventId);
    if (!event) throw new Error('EVENT_NOT_FOUND');

    const tier = await TicketTier.findOne({ _id: ticketTierId, eventId, isActive: true });
    if (!tier) throw new Error('TICKET_TIER_NOT_FOUND');

    if (tier.sold + quantity > tier.capacity) {
      throw new Error('TIER_CAPACITY_EXCEEDED');
    }

    const totalAmount = tier.price * quantity;
    const currency = tier.currency || 'INR';

    // Order must exist at the provider before we record anything locally
    getRazorpayCredentials();
    const receipt = `rcpt_${Date.now()}`;
    const razorpayOrder = await createRazorpayOrder(Math.round(totalAmount * 100), currency, receipt);
    const providerOrderId: string = razorpayOrder.id;

    const order = await orderRepository.create({
      userId: userId as any,
      eventId: eventId as any,
      ticketTierId: ticketTierId as any,
      quantity,
      amount: totalAmount,
      currency,
      providerOrderId,
      status: OrderStatus.PENDING
    });

    const payment = await paymentRepository.create({
      orderId: order._id as any,
      userId: userId as any,
      eventId: eventId as any,
      provider: 'RAZORPAY',
      providerOrderId,
      amountBase: totalAmount,
      taxAmount: 0,
      totalAmount,
      currency,
      status: PaymentStatus.CREATED,
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

  async verifyPayment(userId: string, providerOrderId: string, providerPaymentId: string, signature?: string) {
    const { keySecret } = getRazorpayCredentials();

    const payment = await paymentRepository.findByProviderOrderId(providerOrderId);
    if (!payment || payment.userId.toString() !== userId) throw new Error('PAYMENT_NOT_FOUND');

    const expected = crypto.createHmac('sha256', keySecret).update(`${providerOrderId}|${providerPaymentId}`).digest('hex');
    const isValid = !!signature && safeEqualHex(expected, signature);

    if (!isValid) {
      // A bad signature can fail a pending payment but must never undo one that is already settled
      const failed = await paymentRepository.claimFailed(providerOrderId, providerPaymentId);
      if (failed) await orderRepository.updateStatus((payment.orderId as any).toString(), OrderStatus.FAILED);
      throw new Error('INVALID_PAYMENT_SIGNATURE');
    }

    await settlePaid(providerOrderId, providerPaymentId);

    const current = await paymentRepository.findByProviderOrderId(providerOrderId);
    const order = await orderRepository.findById((payment.orderId as any).toString());
    const invoice = current ? await invoiceRepository.findByPaymentId((current._id as any).toString()) : null;
    return { order, payment: current, invoice };
  },

  // `rawBody` is the exact bytes Razorpay sent: the signature is computed over those, not over a
  // re-serialised copy, which can differ in whitespace, key order and escaping.
  async handleWebhook(rawBody: Buffer | undefined, signature?: string) {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
    }
    if (!signature || !rawBody) {
      throw new Error('INVALID_WEBHOOK_SIGNATURE');
    }

    const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    if (!safeEqualHex(expectedSignature, signature)) {
      throw new Error('INVALID_WEBHOOK_SIGNATURE');
    }

    let eventBody: any;
    try {
      eventBody = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new Error('INVALID_WEBHOOK_SIGNATURE');
    }

    const eventName = eventBody.event;
    const paymentEntity = eventBody.payload?.payment?.entity;
    if (!paymentEntity) return { success: true, message: 'Ignored non-payment event' };

    const providerOrderId = paymentEntity.order_id;
    const providerPaymentId = paymentEntity.id;

    if (eventName === 'payment.captured' || eventName === 'order.paid') {
      await settlePaid(providerOrderId, providerPaymentId);
    } else if (eventName === 'payment.failed') {
      const failed = await paymentRepository.claimFailed(providerOrderId, providerPaymentId);
      if (failed) await orderRepository.updateStatus((failed.orderId as any).toString(), OrderStatus.FAILED);
    }

    return { success: true, event: eventName };
  },

  async getUserOrders(userId: string, page: number = 1, limit: number = 20) {
    return await orderRepository.findByUserId(userId, page, limit);
  },

  async getOrderById(orderId: string, userId: string) {
    const order = await orderRepository.findById(orderId);
    if (!order || order.userId.toString() !== userId) throw new Error('ORDER_NOT_FOUND');
    return order;
  },

  async getInvoiceById(invoiceId: string, userId: string) {
    const invoice = await invoiceRepository.findById(invoiceId);
    if (!invoice || invoice.userId.toString() !== userId) throw new Error('INVOICE_NOT_FOUND');
    return invoice;
  }
};
