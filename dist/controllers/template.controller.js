"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateController = void 0;
const template_service_1 = require("../services/template.service");
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
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
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
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
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
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    }
};
