"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const template_controller_1 = require("../controllers/template.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const template_validator_1 = require("../validators/template.validator");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const router = (0, express_1.Router)();
const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        return res.status(400).json({ success: false, errors: result.error.format() });
    }
    req.body = result.data;
    next();
};
router.use(authenticate_1.authenticate);
// List/View templates for Organizers & Admins
router.get('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), template_controller_1.templateController.getTemplates);
// The designers' default templates: preview what would be created, then install (admin only)
router.get('/defaults', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), template_controller_1.templateController.previewDefaults);
router.post('/defaults', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), template_controller_1.templateController.installDefaults);
// The card a template makes for the event being entered (live preview in the Add Event form)
router.post('/:id/preview', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), rateLimiter_1.cardPreviewLimiter, validate(template_validator_1.previewTemplateCardSchema), template_controller_1.templateController.previewCard);
router.get('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), template_controller_1.templateController.getTemplateById);
// Admin-only template management
router.post('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), validate(template_validator_1.createTemplateSchema), template_controller_1.templateController.createTemplate);
router.patch('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), validate(template_validator_1.updateTemplateSchema), template_controller_1.templateController.updateTemplate);
router.delete('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), template_controller_1.templateController.deleteTemplate);
exports.default = router;
