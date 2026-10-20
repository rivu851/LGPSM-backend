"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateController = void 0;
const template_service_1 = require("../services/template.service");
const defaultTemplates_1 = require("../services/cardTemplates/defaultTemplates");
const preview_1 = require("../services/cardTemplates/preview");
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
            const isAdmin = req.user?.role === 'ADMIN';
            const page = req.query.page ? parseInt(req.query.page, 10) : undefined;
            const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
            const result = await template_service_1.templateService.getTemplates(categoryId, isAdmin, { page, limit });
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
            const png = await (0, preview_1.renderTemplatePreview)(req.params.id, req.body, req.user?.role === 'ADMIN');
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'no-store');
            // the QR on a preview is a placeholder; check-in recognises and rejects it
            res.setHeader('X-Invitation-Qr', 'SAMPLE');
            return res.status(200).send(png);
        }
        catch (error) {
            if (error.message === 'TEMPLATE_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'The preview could not be created. Please try again.' });
        }
    },
    async getTemplateById(req, res) {
        try {
            const template = await template_service_1.templateService.getTemplateById(req.params.id);
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
            const template = await template_service_1.templateService.updateTemplate(req.params.id, req.body);
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
            const template = await template_service_1.templateService.deleteTemplate(req.params.id);
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
