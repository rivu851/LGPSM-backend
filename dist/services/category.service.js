"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryService = void 0;
exports.viewFor = viewFor;
exports.canUseCategory = canUseCategory;
const category_repository_1 = require("../repositories/category.repository");
const Category_1 = require("../models/Category");
const escapeRegex = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const isMine = (ownerId, viewerId) => !!ownerId && !!viewerId && String(ownerId) === String(viewerId);
/**
 * A category as one viewer sees it: the platform's own list plus their own custom ones. Other organizers' custom categories
 * and subcategories are not there at all, and `isCustom` marks the viewer's own so the screens can say so.
 */
function viewFor(category, viewerId) {
    const doc = typeof category.toObject === 'function' ? category.toObject() : category;
    return {
        ...doc,
        isCustom: !!doc.ownerId,
        subcategories: (doc.subcategories || [])
            .filter((s) => !s.ownerId || isMine(s.ownerId, viewerId))
            .map((s) => ({ ...s, isCustom: !!s.ownerId }))
    };
}
/** May this person use (pick, attach to an event or template) the category and subcategory? Someone else's custom ones are treated as missing. */
async function canUseCategory(categoryId, subcategoryId, viewerId) {
    const category = await Category_1.Category.findById(categoryId);
    if (!category)
        return false;
    if (category.ownerId && !isMine(category.ownerId, viewerId))
        return false;
    if (subcategoryId) {
        const sub = (category.subcategories || []).find((x) => String(x._id) === String(subcategoryId));
        if (sub?.ownerId && !isMine(sub.ownerId, viewerId))
            return false;
    }
    return true;
}
exports.categoryService = {
    /** An organizer's own category: only they see it. The name may not repeat anything they can already pick. */
    async createCustomCategory(ownerId, rawName) {
        const name = rawName.trim();
        const visible = await Category_1.Category.find({ $or: [{ ownerId: { $exists: false } }, { ownerId }] }).select('name').lean();
        const clash = visible.find((c) => same(c.name, name));
        if (clash)
            throw { statusCode: 409, message: `"${clash.name}" is already in your list. Pick it from the dropdown.` };
        try {
            return viewFor(await Category_1.Category.create({ name, ownerId, isActive: true }), ownerId);
        }
        catch (e) {
            // another organizer holds the same custom name and the database still has the old global unique index (see the migration script)
            if (e?.code === 11000)
                throw { statusCode: 409, message: 'That name is not available. Please use a different one.' };
            throw e;
        }
    },
    /** An organizer's own subcategory, under the platform's category or one of their own. Nobody else sees it. */
    async addCustomSubcategory(ownerId, categoryId, rawName) {
        const name = rawName.trim();
        const category = await Category_1.Category.findById(categoryId);
        if (!category || !category.isActive || (category.ownerId && !isMine(category.ownerId, ownerId)))
            throw new Error('CATEGORY_NOT_FOUND');
        const clash = category.subcategories.find((s) => (!s.ownerId || isMine(s.ownerId, ownerId)) && same(s.name, name));
        if (clash)
            throw { statusCode: 409, message: `"${clash.name}" is already in ${category.name}. Pick it from the dropdown.` };
        category.subcategories.push({ name, isActive: true, ownerId });
        await category.save();
        return viewFor(category, ownerId);
    },
    async createCategory(data) {
        const name = String(data.name || '').trim();
        const existing = await Category_1.Category.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
        if (existing) {
            throw { statusCode: 409, message: `A category named "${existing.name}" already exists` };
        }
        return await category_repository_1.categoryRepository.create({ ...data, name });
    },
    // Appends one subcategory. Existing subcategories keep their ids, so templates and events that
    // reference them stay valid (rewriting the whole array would mint new ids).
    async addSubcategory(id, rawName) {
        const name = rawName.trim();
        const category = await Category_1.Category.findById(id);
        if (!category)
            throw new Error('CATEGORY_NOT_FOUND');
        if (category.subcategories.some((s) => s.name.trim().toLowerCase() === name.toLowerCase())) {
            throw { statusCode: 409, message: `"${name}" already exists in ${category.name}` };
        }
        category.subcategories.push({ name, isActive: true });
        await category.save();
        return category;
    },
    async getCategories(activeOnly = true, viewerId) {
        const all = await category_repository_1.categoryRepository.findAll(activeOnly);
        return all.filter((c) => !c.ownerId || isMine(c.ownerId, viewerId)).map((c) => viewFor(c, viewerId));
    },
    async getCategoryById(id, viewerId) {
        const category = await category_repository_1.categoryRepository.findById(id);
        if (!category || (category.ownerId && !isMine(category.ownerId, viewerId)))
            throw new Error('CATEGORY_NOT_FOUND');
        return viewFor(category, viewerId);
    },
    async updateCategory(id, updateData) {
        // Organizers' custom subcategories are not shown to the administrator, so their save does not send them: keep them
        if (Array.isArray(updateData.subcategories)) {
            const current = await Category_1.Category.findById(id).select('subcategories').lean();
            const custom = (current?.subcategories || []).filter((s) => s.ownerId);
            if (custom.length)
                updateData = { ...updateData, subcategories: [...updateData.subcategories, ...custom] };
        }
        const category = await category_repository_1.categoryRepository.update(id, updateData);
        if (!category)
            throw new Error('CATEGORY_NOT_FOUND');
        return category;
    },
    async deleteCategory(id) {
        const category = await category_repository_1.categoryRepository.delete(id);
        if (!category)
            throw new Error('CATEGORY_NOT_FOUND');
        return category;
    }
};
