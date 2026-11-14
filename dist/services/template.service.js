"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateService = void 0;
exports.templateVisibleTo = templateVisibleTo;
exports.announceTemplate = announceTemplate;
const mongoose_1 = __importDefault(require("mongoose"));
const alert_service_1 = require("./alert.service");
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
/** A published template everyone can use (an administrator's, not an organizer's private design) is announced to the organizers */
async function announceTemplate(t) {
    if (t.isPublished === false)
        return;
    await alert_service_1.alertService.notifyAllOrganizers({ type: 'TEMPLATE', title: 'New invitation template', message: `The template "${t.name}" is now available. Choose it when you create an event.`, entityType: 'Template', entityId: t._id });
}
exports.templateService = {
    async createTemplate(data) {
        const created = await template_repository_1.templateRepository.create(data);
        await announceTemplate(created);
        return created;
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
        const before = updateData.isPublished === true ? await Template_1.Template.findById(id).select('isPublished').lean() : null;
        const template = await template_repository_1.templateRepository.update(id, updateData);
        if (!template)
            throw new Error('TEMPLATE_NOT_FOUND');
        // a template that has just been published (it was a draft) is announced
        if (before && before.isPublished === false)
            await announceTemplate(template);
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
    /**
     * `ownerId`'s own private template handed to `organizerId` as their own copy (one copy per organizer, however many events use it).
     * Null when `ownerId` does not own an active template with this id. Deleting the original later does not affect the copy.
     */
    async copyOwnTemplateFor(templateId, ownerId, organizerId) {
        if (!mongoose_1.default.Types.ObjectId.isValid(templateId))
            return null;
        const source = await Template_1.Template.findOne({ _id: templateId, ownerId, isSystemTemplate: { $ne: true }, isActive: { $ne: false } }).lean();
        if (!source)
            return null;
        const existing = await Template_1.Template.findOne({ ownerId: organizerId, copiedFromId: source._id, isActive: { $ne: false } }).select('_id').lean();
        if (existing)
            return String(existing._id);
        const { _id, createdAt, updatedAt, __v, ...rest } = source;
        const copy = await Template_1.Template.create({ ...rest, ownerId: organizerId, copiedFromId: _id, isSystemTemplate: false, isPublished: true });
        return String(copy._id);
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
