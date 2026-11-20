"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const billing_service_1 = require("../services/billing.service");
const zod_1 = require("zod");
const router = (0, express_1.Router)();
// applied per route (not router-wide): this router is mounted at /api/v1, so a blanket guard would also answer 401/403 for unknown paths
const organizerOnly = [authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER)];
const fail = (res, error) => {
    const map = {
        EVENT_NOT_FOUND: [404, 'Event not found'],
        RATE_NOT_SET: [409, 'No per-invitee rate is set for this event yet, so there is nothing to pay.'],
        NOTHING_DUE: [409, 'Nothing is due for this event.'],
        PAYMENT_PROVIDER_NOT_CONFIGURED: [503, 'Online payments are not configured on this server'],
        PAYMENT_PROVIDER_ERROR: [502, 'The payment provider could not create the order. Please try again.']
    };
    const hit = map[error?.message];
    if (hit)
        return res.status(hit[0]).json({ success: false, message: hit[1] });
    console.error('Billing request failed:', error?.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};
// What is billed, paid and due for each of the organizer's events
router.get('/billing/events', organizerOnly, async (req, res) => {
    try {
        return res.json({ success: true, data: await billing_service_1.billingService.listEventBills(req.user.userId) });
    }
    catch (e) {
        return fail(res, e);
    }
});
// Starts a Razorpay payment for what is due on one event; the client then confirms it through POST /payments/verify
const objectId = zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/);
const payBody = zod_1.z.object({ eventId: objectId, inviteeIds: zod_1.z.array(objectId).max(5000).optional() });
router.post('/billing/quote', organizerOnly, async (req, res) => {
    const parsed = payBody.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ success: false, message: 'A valid eventId is required.' });
    try {
        return res.json({ success: true, data: await billing_service_1.billingService.quote(req.user.userId, parsed.data.eventId, parsed.data.inviteeIds || []) });
    }
    catch (e) {
        return fail(res, e);
    }
});
router.post('/billing/pay', organizerOnly, async (req, res) => {
    const parsed = payBody.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ success: false, message: 'A valid eventId is required.' });
    try {
        return res.status(201).json({ success: true, data: await billing_service_1.billingService.createBillOrder(req.user.userId, parsed.data.eventId, parsed.data.inviteeIds) });
    }
    catch (e) {
        return fail(res, e);
    }
});
router.get('/billing/invoices', organizerOnly, async (req, res) => {
    try {
        return res.json({ success: true, data: await billing_service_1.billingService.listInvoices(req.user.userId) });
    }
    catch (e) {
        return fail(res, e);
    }
});
exports.default = router;
