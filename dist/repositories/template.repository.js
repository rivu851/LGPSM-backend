"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateRepository = void 0;
const Template_1 = require("../models/Template");
exports.templateRepository = {
    async create(data) {
        return await Template_1.Template.create(data);
    },
    async findAll(categoryId, includeDrafts = false, options = {}) {
        const query = { isActive: true };
        // Templates created before the publish flag existed count as published
        if (!includeDrafts)
            query.isPublished = { $ne: false };
        if (categoryId)
            query.categoryId = categoryId;
        let cursor = Template_1.Template.find(query).populate('categoryId').sort({ createdAt: -1, _id: -1 });
        if (options.skip)
            cursor = cursor.skip(options.skip);
        if (options.limit)
            cursor = cursor.limit(options.limit);
        return await cursor;
    },
    async count(categoryId, includeDrafts = false) {
        const query = { isActive: true };
        if (!includeDrafts)
            query.isPublished = { $ne: false };
        if (categoryId)
            query.categoryId = categoryId;
        return await Template_1.Template.countDocuments(query);
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
