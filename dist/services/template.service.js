"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateService = void 0;
const template_repository_1 = require("../repositories/template.repository");
exports.templateService = {
    async createTemplate(data) {
        return await template_repository_1.templateRepository.create(data);
    },
    async getTemplates(categoryId, includeDrafts = false) {
        return await template_repository_1.templateRepository.findAll(categoryId, includeDrafts);
    },
    async getTemplateById(id) {
        const template = await template_repository_1.templateRepository.findById(id);
        if (!template)
            throw new Error('TEMPLATE_NOT_FOUND');
        return template;
    },
    async updateTemplate(id, updateData) {
        const template = await template_repository_1.templateRepository.update(id, updateData);
        if (!template)
            throw new Error('TEMPLATE_NOT_FOUND');
        return template;
    },
    async deleteTemplate(id) {
        const template = await template_repository_1.templateRepository.delete(id);
        if (!template)
            throw new Error('TEMPLATE_NOT_FOUND');
        return template;
    }
};
