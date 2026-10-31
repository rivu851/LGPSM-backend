"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const publicInvitation_controller_1 = require("../controllers/publicInvitation.controller");
const publicInvitation_validator_1 = require("../validators/publicInvitation.validator");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const router = (0, express_1.Router)();
router.use(rateLimiter_1.publicInvitationLimiter);
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
// GET /api/v1/public/invitations/:token
router.get('/:token/card', publicInvitation_controller_1.publicInvitationController.getPublicInvitationCard);
router.get('/:token', publicInvitation_controller_1.publicInvitationController.getPublicInvitation);
// POST /api/v1/public/invitations/:token/rsvp
router.post('/:token/rsvp', validate(publicInvitation_validator_1.submitRsvpSchema), publicInvitation_controller_1.publicInvitationController.submitRsvp);
// POST /api/v1/public/invitations/:token/food  (events without RSVP: the guest's required food choice)
router.post('/:token/food', validate(publicInvitation_validator_1.submitFoodSchema), publicInvitation_controller_1.publicInvitationController.submitFoodPreference);
exports.default = router;
