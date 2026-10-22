"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const template_controller_1 = require("../controllers/template.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const template_validator_1 = require("../validators/template.validator");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const Template_1 = require("../models/Template");
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
// The card an event gets when no template is chosen: the design that suits its type (live preview in the Add Event form)
router.post('/preview', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), rateLimiter_1.cardPreviewLimiter, validate(template_validator_1.previewTemplateCardSchema), template_controller_1.templateController.previewCard);
// The card a template makes for the event being entered (live preview in the Add Event form)
router.post('/:id/preview', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), rateLimiter_1.cardPreviewLimiter, validate(template_validator_1.previewTemplateCardSchema), template_controller_1.templateController.previewCard);
// A custom template drawn with a real event's details at full size (PNG or JPEG)
router.post('/:id/render', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), rateLimiter_1.templateRenderLimiter, validate(template_validator_1.renderTemplateForEventSchema), template_controller_1.templateController.renderForEvent);
router.get('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), template_controller_1.templateController.getTemplateById);
// Admins manage every template. Organizers manage only their own AI templates (the controller scopes them to the
// owner), and with a narrower body: they cannot change ownership, visibility to others or the render engine.
router.post('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), validate(template_validator_1.createTemplateSchema), template_controller_1.templateController.createTemplate);
// Before any body is validated: admins pass; an organizer must own the template. The designers' templates answer 403
// (as before), another organizer's private template answers 404 so its id reveals nothing.
const requireOwnerOrAdmin = async (req, res, next) => {
    try {
        if (req.user?.role === User_1.Role.ADMIN)
            return next();
        const template = await Template_1.Template.findById(req.params.id).select('ownerId isActive').lean();
        if (!template || template.isActive === false)
            return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
        if (!template.ownerId)
            return res.status(403).json({ success: false, message: 'Only an admin can change this template' });
        if (String(template.ownerId) !== req.user?.userId)
            return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
        next();
    }
    catch (error) {
        console.error('Request failed:', error?.message);
        return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
};
const validateByRole = (adminSchema, ownerSchema) => (req, res, next) => validate(req.user?.role === User_1.Role.ADMIN ? adminSchema : ownerSchema)(req, res, next);
router.patch('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), requireOwnerOrAdmin, validateByRole(template_validator_1.updateTemplateSchema, template_validator_1.updateOwnTemplateSchema), template_controller_1.templateController.updateTemplate);
router.delete('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), requireOwnerOrAdmin, template_controller_1.templateController.deleteTemplate);
exports.default = router;
