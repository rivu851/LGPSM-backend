"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const invitation_controller_1 = require("../controllers/invitation.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const invitation_validator_1 = require("../validators/invitation.validator");
const router = (0, express_1.Router)({ mergeParams: true });
const validate = (schema) => (req, res, next) => {
    try {
        const parsed = schema.parse({ body: req.body });
        req.body = { ...req.body, ...parsed.body };
        next();
    }
    catch (err) {
        res.status(400).json({ success: false, error: 'Validation Error', message: err.issues?.[0]?.message || 'Invalid input data', details: err.issues ?? err.errors });
    }
};
router.use(authenticate_1.authenticate);
// POST /api/v1/events/:eventId/invitations/send
router.post('/send', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), validate(invitation_validator_1.sendInvitationSchema), invitation_controller_1.invitationController.sendInvitations);
// POST /api/v1/events/:eventId/invitations/resend
router.post('/resend', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), validate(invitation_validator_1.resendInvitationSchema), invitation_controller_1.invitationController.resendInvitations);
// GET /api/v1/events/:eventId/invitations/preview
router.get('/preview', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), invitation_controller_1.invitationController.previewInvitationCard);
// GET /api/v1/events/:eventId/invitations
router.get('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), invitation_controller_1.invitationController.getInvitations);
// DELETE /api/v1/events/:eventId/invitations/history  (hides delivery history; records are kept)
router.delete('/history', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), invitation_controller_1.invitationController.clearHistory);
exports.default = router;
