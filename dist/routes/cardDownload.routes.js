"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const auditAction_1 = require("../middlewares/auditAction");
const User_1 = require("../models/User");
const cardDownload_service_1 = require("../services/cardDownload.service");
const router = (0, express_1.Router)({ mergeParams: true });
router.use(authenticate_1.authenticate);
const objectId = zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/);
const body = zod_1.z.object({
    perZip: zod_1.z.number().int().min(1).max(cardDownload_service_1.MAX_PER_ZIP),
    part: zod_1.z.number().int().min(1).optional(),
    inviteeIds: zod_1.z.array(objectId).max(20000).optional()
});
const handle = (res, e) => {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    const status = e?.statusCode || 500;
    if (status === 500)
        console.error('Card download failed:', e?.message);
    res.status(status).json({ success: false, code: e?.code, message: status === 500 ? 'The cards could not be produced. Please try again.' : e.message });
};
// POST /api/v1/events/:eventId/invitation-cards/plan: how many guests and how many zip files
router.post('/plan', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), async (req, res) => {
    const p = body.safeParse(req.body);
    if (!p.success)
        return res.status(400).json({ success: false, message: `Guests per zip must be a whole number from 1 to ${cardDownload_service_1.MAX_PER_ZIP}.` });
    try {
        res.json({ success: true, data: await cardDownload_service_1.cardDownloadService.plan(req.user, String(req.params.eventId), p.data.perZip, p.data.inviteeIds) });
    }
    catch (e) {
        handle(res, e);
    }
});
// POST /api/v1/events/:eventId/invitation-cards/download: one zip (part n) of printable PDFs, one PDF per guest
router.post('/download', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), (0, auditAction_1.auditAction)({ action: 'INVITATION_CARDS_DOWNLOADED', entityType: 'Event', eventParam: 'eventId', describe: 'Printable invitation cards were downloaded' }), async (req, res) => {
    const p = body.safeParse(req.body);
    if (!p.success)
        return res.status(400).json({ success: false, message: `Guests per zip must be a whole number from 1 to ${cardDownload_service_1.MAX_PER_ZIP}.` });
    try {
        await cardDownload_service_1.cardDownloadService.streamZip(req.user, String(req.params.eventId), { part: p.data.part ?? 1, perZip: p.data.perZip, inviteeIds: p.data.inviteeIds }, res);
    }
    catch (e) {
        handle(res, e);
    }
});
// GET /api/v1/events/:eventId/invitation-cards/download?perZip=&part=&inviteeIds=a,b: the same zip for clients that can only download with GET
// (the mobile app saves files through the system downloader)
router.get('/download', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), (0, auditAction_1.auditAction)({ action: 'INVITATION_CARDS_DOWNLOADED', entityType: 'Event', eventParam: 'eventId', describe: 'Printable invitation cards were downloaded' }), async (req, res) => {
    const ids = typeof req.query.inviteeIds === 'string' && req.query.inviteeIds ? req.query.inviteeIds.split(',') : undefined;
    const p = body.safeParse({ perZip: Number(req.query.perZip), part: req.query.part ? Number(req.query.part) : undefined, inviteeIds: ids });
    if (!p.success)
        return res.status(400).json({ success: false, message: `Guests per zip must be a whole number from 1 to ${cardDownload_service_1.MAX_PER_ZIP}.` });
    try {
        await cardDownload_service_1.cardDownloadService.streamZip(req.user, String(req.params.eventId), { part: p.data.part ?? 1, perZip: p.data.perZip, inviteeIds: p.data.inviteeIds }, res);
    }
    catch (e) {
        handle(res, e);
    }
});
exports.default = router;
