"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateController = void 0;
const template_service_1 = require("../services/template.service");
const defaultTemplates_1 = require("../services/cardTemplates/defaultTemplates");
const preview_1 = require("../services/cardTemplates/preview");
const renderForEvent_1 = require("../services/cardTemplates/renderForEvent");
const previewImage_1 = require("../utils/previewImage");
const viewerOf = (req) => ({ userId: req.user?.userId, isAdmin: req.user?.role === 'ADMIN' });
const isOrganizer = (req) => req.user?.role !== 'ADMIN';
exports.templateController = {
    async createTemplate(req, res) {
        try {
            const template = await template_service_1.templateService.createTemplate(req.body);
            return res.status(201).json({ success: true, data: template });
        }
        catch (error) {
            return res.status(400).json({ error: 'Bad Request', message: error.message });
        }
    },
    async getTemplates(req, res) {
        try {
            const categoryId = req.query.categoryId;
            const page = req.query.page ? parseInt(req.query.page, 10) : undefined;
            const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
            const kind = req.query.kind === 'POSTER' || req.query.kind === 'INVITATION' ? req.query.kind : undefined;
            const result = await template_service_1.templateService.getTemplates(categoryId, viewerOf(req), { page, limit, kind, mineOnly: req.query.scope === 'mine' });
            return res.status(200).json({
                success: true,
                data: result.templates,
                meta: { page: result.page, limit: result.limit, total: result.total, totalPages: result.totalPages },
            });
        }
        catch (error) {
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    },
    // What installing the designers' default templates would create (nothing is changed)
    async previewDefaults(_req, res) {
        try {
            return res.status(200).json({ success: true, data: await (0, defaultTemplates_1.planDefaultTemplates)() });
        }
        catch (error) {
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    },
    // Creates the designers' default templates (and any category they need) that do not exist yet
    async installDefaults(req, res) {
        try {
            const result = await (0, defaultTemplates_1.installDefaultTemplates)(req.user.userId);
            return res.status(200).json({ success: true, data: result });
        }
        catch (error) {
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'The default templates could not be installed. Please try again.' });
        }
    },
    // The card this template produces for the event being entered (nothing is saved)
    async previewCard(req, res) {
        try {
            const viewer = viewerOf(req);
            const png = await (0, preview_1.renderTemplatePreview)(req.params.id ?? null, req.body, viewer.isAdmin, viewer.userId);
            const shaped = await (0, previewImage_1.shapePreview)(png, req.query);
            res.setHeader('Content-Type', shaped.contentType);
            res.setHeader('Cache-Control', 'no-store');
            // the QR on a preview is a placeholder; check-in recognises and rejects it
            res.setHeader('X-Invitation-Qr', 'SAMPLE');
            return res.status(200).send(shaped.body);
        }
        catch (error) {
            if (error.message === 'TEMPLATE_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
            if (error.message === 'TEMPLATE_NOT_USABLE')
                return res.status(409).json({ error: 'Conflict', message: 'This template cannot be drawn. Please regenerate it.' });
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'The preview could not be created. Please try again.' });
        }
    },
    // The template drawn with a real event's details (posters get their registration QR; invitations a marked sample QR)
    async renderForEvent(req, res) {
        try {
            const user = req.user;
            const { eventId, registrationUrl, format } = req.body;
            const out = await (0, renderForEvent_1.renderTemplateForEvent)({ templateId: req.params.id, eventId, registrationUrl, format, userId: user.userId, isAdmin: user.role === 'ADMIN' });
            res.setHeader('Content-Type', out.contentType);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Invitation-Qr', out.qr);
            if (out.warnings.length)
                res.setHeader('X-Render-Warnings', out.warnings.map((w) => w.replace(/[^\x20-\x7e]/g, ' ')).join('; ').slice(0, 300));
            return res.status(200).send(out.body);
        }
        catch (error) {
            if (error.message === 'TEMPLATE_NOT_FOUND' || error.message === 'EVENT_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: error.message === 'EVENT_NOT_FOUND' ? 'Event not found' : 'Template not found' });
            if (error.message === 'TEMPLATE_NOT_USABLE')
                return res.status(409).json({ error: 'Conflict', message: 'This template cannot be drawn. Please regenerate it.' });
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'The image could not be created. Please try again.' });
        }
    },
    async getTemplateById(req, res) {
        try {
            const template = await template_service_1.templateService.getTemplateById(req.params.id, viewerOf(req));
            return res.status(200).json({ success: true, data: template });
        }
        catch (error) {
            if (error.message === 'TEMPLATE_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    },
    async updateTemplate(req, res) {
        try {
            const template = isOrganizer(req)
                ? await template_service_1.templateService.updateOwnTemplate(req.params.id, req.user.userId, req.body)
                : await template_service_1.templateService.updateTemplate(req.params.id, req.body);
            return res.status(200).json({ success: true, data: template });
        }
        catch (error) {
            if (error.message === 'TEMPLATE_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
            return res.status(400).json({ error: 'Bad Request', message: error.message });
        }
    },
    async deleteTemplate(req, res) {
        try {
            const template = isOrganizer(req)
                ? await template_service_1.templateService.deleteOwnTemplate(req.params.id, req.user.userId)
                : await template_service_1.templateService.deleteTemplate(req.params.id);
            return res.status(200).json({ success: true, message: 'Template deactivated successfully', data: template });
        }
        catch (error) {
            if (error.message === 'TEMPLATE_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    }
};
