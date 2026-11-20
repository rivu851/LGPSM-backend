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
const planBody = zod_1.z.object({ inviteeIds: zod_1.z.array(objectId).min(1, 'Select at least one guest.').max(20000) });
const partInput = zod_1.z.object({ planId: objectId, part: zod_1.z.number().int().min(1) });
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
// POST /api/v1/events/:eventId/invitation-cards/plan: keeps the selected guests and says how many zip files they make (the system splits
// them evenly, at most 100 guests per zip)
router.post('/plan', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), async (req, res) => {
    const p = planBody.safeParse(req.body);
    if (!p.success)
        return res.status(400).json({ success: false, code: 'NO_GUESTS_SELECTED', message: p.error.issues[0]?.message || 'Select at least one guest.' });
    try {
        res.json({ success: true, data: await cardDownload_service_1.cardDownloadService.plan(req.user, String(req.params.eventId), p.data.inviteeIds) });
    }
    catch (e) {
        handle(res, e);
    }
});
const stream = async (req, res, input) => {
    const p = partInput.safeParse(input);
    if (!p.success)
        return res.status(400).json({ success: false, message: 'A plan and a part number are required.' });
    try {
        await cardDownload_service_1.cardDownloadService.streamZip(req.user, String(req.params.eventId), p.data, res);
    }
    catch (e) {
        handle(res, e);
    }
};
const audit = (0, auditAction_1.auditAction)({ action: 'INVITATION_CARDS_DOWNLOADED', entityType: 'Event', eventParam: 'eventId', describe: 'Printable invitation cards were downloaded' });
// POST /api/v1/events/:eventId/invitation-cards/download { planId, part }: one zip of printable PDFs, one PDF per guest
router.post('/download', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), audit, (req, res) => stream(req, res, req.body));
// GET .../download?planId=&part=: the same for clients that can only download with GET (the mobile app's system downloader)
router.get('/download', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), audit, (req, res) => stream(req, res, { planId: req.query.planId, part: Number(req.query.part) }));
exports.default = router;
