import { Request, Response } from 'express';
import { securityEvent } from '../utils/securityLog';
import { paymentService } from '../services/payment.service';

export const paymentController = {
  async createTicketOrder(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      const { eventId, ticketTierId, quantity } = req.body;

      const result = await paymentService.createTicketOrder(userId, eventId, ticketTierId, quantity);
      return res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Event not found' });
      if (error.message === 'TICKET_TIER_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Ticket tier not found' });
      if (error.message === 'TIER_CAPACITY_EXCEEDED') return res.status(400).json({ error: 'Bad Request', message: 'Ticket tier capacity exceeded' });
      if (error.message === 'PAYMENT_PROVIDER_NOT_CONFIGURED') return res.status(503).json({ success: false, error: 'Service Unavailable', message: 'Online payments are not configured on this server' });
      if (error.message === 'PAYMENT_PROVIDER_ERROR') return res.status(502).json({ success: false, error: 'Bad Gateway', message: 'Payment provider could not create the order' });
      console.error('Payment request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async verifyPayment(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      const { providerOrderId, providerPaymentId, signature } = req.body;

      const result = await paymentService.verifyPayment(userId, providerOrderId, providerPaymentId, signature);
      return res.status(200).json({ success: true, message: 'Payment verified successfully', data: result });
    } catch (error: any) {
      if (error.message === 'PAYMENT_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Payment record not found' });
      if (error.message === 'INVALID_PAYMENT_SIGNATURE') securityEvent('PAYMENT_SIGNATURE_INVALID', req);
      if (error.message === 'INVALID_PAYMENT_SIGNATURE') return res.status(400).json({ error: 'Bad Request', message: 'Payment signature verification failed' });
      if (error.message === 'PAYMENT_PROVIDER_NOT_CONFIGURED') return res.status(503).json({ success: false, error: 'Service Unavailable', message: 'Online payments are not configured on this server' });
      if (error.message === 'PAYMENT_PROVIDER_ERROR') return res.status(502).json({ success: false, error: 'Bad Gateway', message: 'Payment provider could not create the order' });
      console.error('Payment request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async handleWebhook(req: Request, res: Response) {
    try {
      const signature = req.headers['x-razorpay-signature'] as string;
      const result = await paymentService.handleWebhook((req as any).rawBody, signature);
      return res.status(200).json(result);
    } catch (error: any) {
      if (error.message === 'INVALID_WEBHOOK_SIGNATURE') securityEvent('WEBHOOK_SIGNATURE_INVALID', req);
      if (error.message === 'INVALID_WEBHOOK_SIGNATURE') return res.status(400).json({ error: 'Bad Request', message: 'Invalid webhook signature' });
      if (error.message === 'PAYMENT_PROVIDER_NOT_CONFIGURED') return res.status(503).json({ success: false, error: 'Service Unavailable', message: 'Online payments are not configured on this server' });
      if (error.message === 'PAYMENT_PROVIDER_ERROR') return res.status(502).json({ success: false, error: 'Bad Gateway', message: 'Payment provider could not create the order' });
      console.error('Payment request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async getUserOrders(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      const result = await paymentService.getUserOrders(userId, page, limit);
      return res.status(200).json({ success: true, data: result.orders, meta: { total: result.total, page: result.page, totalPages: result.totalPages } });
    } catch (error: any) {
      if (error.message === 'PAYMENT_PROVIDER_NOT_CONFIGURED') return res.status(503).json({ success: false, error: 'Service Unavailable', message: 'Online payments are not configured on this server' });
      if (error.message === 'PAYMENT_PROVIDER_ERROR') return res.status(502).json({ success: false, error: 'Bad Gateway', message: 'Payment provider could not create the order' });
      console.error('Payment request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async getOrderById(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      const order = await paymentService.getOrderById(req.params.id as string, userId);
      return res.status(200).json({ success: true, data: order });
    } catch (error: any) {
      if (error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Order not found' });
      if (error.message === 'PAYMENT_PROVIDER_NOT_CONFIGURED') return res.status(503).json({ success: false, error: 'Service Unavailable', message: 'Online payments are not configured on this server' });
      if (error.message === 'PAYMENT_PROVIDER_ERROR') return res.status(502).json({ success: false, error: 'Bad Gateway', message: 'Payment provider could not create the order' });
      console.error('Payment request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async getInvoiceById(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      const invoice = await paymentService.getInvoiceById(req.params.id as string, userId);
      return res.status(200).json({ success: true, data: invoice });
    } catch (error: any) {
      if (error.message === 'INVOICE_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Invoice not found' });
      if (error.message === 'PAYMENT_PROVIDER_NOT_CONFIGURED') return res.status(503).json({ success: false, error: 'Service Unavailable', message: 'Online payments are not configured on this server' });
      if (error.message === 'PAYMENT_PROVIDER_ERROR') return res.status(502).json({ success: false, error: 'Bad Gateway', message: 'Payment provider could not create the order' });
      console.error('Payment request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  }
};
