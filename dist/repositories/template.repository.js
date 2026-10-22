"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateRepository = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const Template_1 = require("../models/Template");
function listQuery(categoryId, viewer, options) {
    const query = { isActive: true };
    if (categoryId)
        query.categoryId = categoryId;
    if (options.kind)
        query.kind = options.kind === 'INVITATION' ? { $in: ['INVITATION', null] } : 'POSTER';
    const own = viewer.userId && mongoose_1.default.Types.ObjectId.isValid(viewer.userId) ? { ownerId: new mongoose_1.default.Types.ObjectId(viewer.userId) } : null;
    if (options.mineOnly) {
        query.ownerId = own?.ownerId ?? { $exists: false, $eq: null };
        return query;
    }
    if (!viewer.isAdmin) {
        // Templates created before the publish flag existed count as published. A template with an owner is a private
        // AI design unless an admin published it as a system template, so another organizer's never appears.
        const visible = [{ ownerId: { $exists: false }, isPublished: { $ne: false } }, { isSystemTemplate: true, isPublished: true }];
        // the owner's published templates are offered for their events; drafts live in the "mine" list until published
        if (own)
            visible.push({ ...own, isPublished: true });
        query.$or = visible;
    }
    return query;
}
exports.templateRepository = {
    async create(data) {
        return await Template_1.Template.create(data);
    },
    async findAll(categoryId, viewer, options = {}) {
        let cursor = Template_1.Template.find(listQuery(categoryId, viewer, options)).populate('categoryId').sort({ createdAt: -1, _id: -1 });
        if (options.skip)
            cursor = cursor.skip(options.skip);
        if (options.limit)
            cursor = cursor.limit(options.limit);
        return await cursor;
    },
    async count(categoryId, viewer, options = {}) {
        return await Template_1.Template.countDocuments(listQuery(categoryId, viewer, options));
    },
    async findById(id) {
        return await Template_1.Template.findById(id).populate('categoryId');
    },
    async update(id, updateData) {
        return await Template_1.Template.findByIdAndUpdate(id, updateData, { new: true });
    },
    async delete(id) {
        return await Template_1.Template.findByIdAndUpdate(id, { isActive: false }, { new: true });
    }
};
