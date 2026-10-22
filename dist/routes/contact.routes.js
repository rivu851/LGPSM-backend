"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const contact_controller_1 = require("../controllers/contact.controller");
const contact_validator_1 = require("../validators/contact.validator");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const router = (0, express_1.Router)();
const validate = (schema) => (req, res, next) => {
    const parsed = schema.safeParse({ body: req.body });
    if (!parsed.success) {
        const issues = parsed.error.issues;
        // Only the field path and a human-readable message are exposed (not the validator's internals)
        const details = issues.map((i) => ({ path: i.path, message: i.message }));
        return res.status(400).json({ success: false, error: 'Validation Error', message: issues[0]?.message || 'Invalid input data', details });
    }
    req.body = { ...req.body, ...parsed.data.body };
    next();
};
// POST /api/v1/public/contact — unauthenticated by design (visitors have no account)
router.post('/', rateLimiter_1.contactAttemptLimiter, rateLimiter_1.contactRateLimiter, validate(contact_validator_1.submitContactSchema), contact_controller_1.contactController.submit);
exports.default = router;
