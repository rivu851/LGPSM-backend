"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const templateGeneration_controller_1 = require("../controllers/templateGeneration.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const template_validator_1 = require("../validators/template.validator");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const router = (0, express_1.Router)();
const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: result.error.issues[0]?.message || 'Invalid request', errors: result.error.format() });
    }
    req.body = result.data;
    next();
};
const validIndex = (req, res, next) => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index > 2)
        return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: 'Invalid design number' });
    next();
};
// Organizers generate for themselves; admins for themselves and can inspect anyone's. Staff accounts have no access.
router.use(authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN));
router.get('/options', rateLimiter_1.templateGenerationReadLimiter, templateGeneration_controller_1.templateGenerationController.options);
router.get('/', rateLimiter_1.templateGenerationReadLimiter, templateGeneration_controller_1.templateGenerationController.list);
router.post('/', rateLimiter_1.templateGenerationLimiter, validate(template_validator_1.createGenerationSchema), templateGeneration_controller_1.templateGenerationController.create);
// change a design that is already saved as a template (the owner's, or any for an admin)
router.post('/from-template/:templateId/edit', rateLimiter_1.templateGenerationLimiter, validate(template_validator_1.changeGenerationSchema), templateGeneration_controller_1.templateGenerationController.editSaved);
router.get('/:id', rateLimiter_1.templateGenerationReadLimiter, templateGeneration_controller_1.templateGenerationController.get);
router.delete('/:id', templateGeneration_controller_1.templateGenerationController.remove);
router.post('/:id/variants/:index/edit', rateLimiter_1.templateGenerationLimiter, validIndex, validate(template_validator_1.changeGenerationSchema), templateGeneration_controller_1.templateGenerationController.edit);
router.post('/:id/variants/:index/variations', rateLimiter_1.templateGenerationLimiter, validIndex, validate(template_validator_1.changeGenerationSchema), templateGeneration_controller_1.templateGenerationController.variations);
router.post('/:id/variants/:index/save', validIndex, validate(template_validator_1.saveVariantSchema), templateGeneration_controller_1.templateGenerationController.save);
exports.default = router;
