"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateService = void 0;
exports.templateVisibleTo = templateVisibleTo;
const mongoose_1 = __importDefault(require("mongoose"));
const template_repository_1 = require("../repositories/template.repository");
const Template_1 = require("../models/Template");
/** Can this viewer see/use this template? Mirrors the list rules in template.repository.ts. */
function templateVisibleTo(template, viewer) {
    if (template.isActive === false && !viewer.isAdmin)
        return false;
    if (viewer.isAdmin)
        return true;
    if (template.ownerId)
        return String(template.ownerId) === viewer.userId || (template.isSystemTemplate && template.isPublished === true);
    return template.isPublished !== false;
}
exports.templateService = {
    async createTemplate(data) {
        return await template_repository_1.templateRepository.create(data);
    },
    async getTemplates(categoryId, viewer, options = {}) {
        const page = Math.max(options.page || 1, 1);
        const limit = Math.min(Math.max(options.limit || 25, 1), 100);
        const skip = (page - 1) * limit;
        const listOptions = { skip, limit, mineOnly: options.mineOnly, kind: options.kind };
        const [templates, total] = await Promise.all([
            template_repository_1.templateRepository.findAll(categoryId, viewer, listOptions),
            template_repository_1.templateRepository.count(categoryId, viewer, listOptions),
        ]);
        return { templates, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
    },
    /** A template the viewer may see; anything else is reported as missing so another tenant's ids reveal nothing. */
    async getTemplateById(id, viewer) {
        const template = await template_repository_1.templateRepository.findById(id);
        if (!template || (viewer && !templateVisibleTo(template, viewer)))
            throw new Error('TEMPLATE_NOT_FOUND');
        return template;
    },
    async updateTemplate(id, updateData) {
        const template = await template_repository_1.templateRepository.update(id, updateData);
        if (!template)
            throw new Error('TEMPLATE_NOT_FOUND');
        return template;
    },
    /** An organizer changing their own AI template: only fields they may edit, only on a template they own. */
    async updateOwnTemplate(id, userId, updateData) {
        if (!mongoose_1.default.Types.ObjectId.isValid(id))
            throw new Error('TEMPLATE_NOT_FOUND');
        const template = await Template_1.Template.findOneAndUpdate({ _id: id, ownerId: userId, isActive: { $ne: false } }, updateData, { new: true });
        if (!template)
            throw new Error('TEMPLATE_NOT_FOUND');
        return template;
    },
    async deleteTemplate(id) {
        const template = await template_repository_1.templateRepository.delete(id);
        if (!template)
            throw new Error('TEMPLATE_NOT_FOUND');
        return template;
    },
    async deleteOwnTemplate(id, userId) {
        if (!mongoose_1.default.Types.ObjectId.isValid(id))
            throw new Error('TEMPLATE_NOT_FOUND');
        const template = await Template_1.Template.findOneAndUpdate({ _id: id, ownerId: userId, isActive: { $ne: false } }, { isActive: false }, { new: true });
        if (!template)
            throw new Error('TEMPLATE_NOT_FOUND');
        return template;
    },
    /** May an event owned by `organizerId` use this template? Legacy/system templates always; an owned template only by its owner. */
    async isUsableByOrganizer(templateId, organizerId) {
        if (!mongoose_1.default.Types.ObjectId.isValid(templateId))
            return false;
        const template = await Template_1.Template.findById(templateId).select('ownerId isSystemTemplate isPublished isActive').lean();
        if (!template)
            return false;
        if (!template.ownerId)
            return true;
        if (template.isActive === false)
            return false;
        return String(template.ownerId) === String(organizerId) || (template.isSystemTemplate === true && template.isPublished === true);
    }
};
