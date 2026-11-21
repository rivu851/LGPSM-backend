import { Router, Request, Response } from 'express';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { billingService } from '../services/billing.service';
import { z } from 'zod';
import { perUserLimit, dedupeWindow } from '../middlewares/userRateLimit';

const router = Router();
// applied per route (not router-wide): this router is mounted at /api/v1, so a blanket guard would also answer 401/403 for unknown paths
const organizerOnly = [authenticate, authorizeRoles(Role.ORGANIZER)];

const fail = (res: Response, error: any) => {
  const map: Record<string, [number, string]> = {
    EVENT_NOT_FOUND: [404, 'Event not found'],
    RATE_NOT_SET: [409, 'No per-invitee rate is set for this event yet, so there is nothing to pay.'],
    NOTHING_DUE: [409, 'Nothing is due for this event.'],
    PAYMENT_PROVIDER_NOT_CONFIGURED: [503, 'Online payments are not configured on this server'],
    PAYMENT_PROVIDER_ERROR: [502, 'The payment provider could not create the order. Please try again.']
  };
  const hit = map[error?.message];
  if (hit) return res.status(hit[0]).json({ success: false, message: hit[1] });
  console.error('Billing request failed:', error?.message);
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};

// What is billed, paid and due for each of the organizer's events
router.get('/billing/events', organizerOnly, async (req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await billingService.listEventBills((req as any).user.userId) });
  } catch (e) { return fail(res, e); }
});

// Starts a Razorpay payment for what is due on one event; the client then confirms it through POST /payments/verify
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const payBody = z.object({ eventId: objectId, inviteeIds: z.array(objectId).max(5000).optional() });

router.post('/billing/quote', organizerOnly, perUserLimit('billing-quote', { windowMs: 60_000, max: 30 }), async (req: Request, res: Response) => {
  const parsed = payBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'A valid eventId is required.' });
  try {
    return res.json({ success: true, data: await billingService.quote((req as any).user.userId, parsed.data.eventId, parsed.data.inviteeIds || []) });
  } catch (e) { return fail(res, e); }
});

router.post('/billing/pay', organizerOnly, perUserLimit('billing-pay', { windowMs: 60_000, max: 10, message: 'Too many payment attempts. Please wait a minute and try again.' }), dedupeWindow('billing-pay', 3_000), async (req: Request, res: Response) => {
  const parsed = payBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'A valid eventId is required.' });
  try {
    return res.status(201).json({ success: true, data: await billingService.createBillOrder((req as any).user.userId, parsed.data.eventId, parsed.data.inviteeIds) });
  } catch (e) { return fail(res, e); }
});

router.get('/billing/invoices', organizerOnly, async (req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await billingService.listInvoices((req as any).user.userId) });
  } catch (e) { return fail(res, e); }
});

export default router;
