"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryService = void 0;
exports.viewFor = viewFor;
exports.canUseCategory = canUseCategory;
const category_repository_1 = require("../repositories/category.repository");
const mongoose_1 = __importDefault(require("mongoose"));
const Category_1 = require("../models/Category");
const alert_service_1 = require("./alert.service");
const Template_1 = require("../models/Template");
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
    // a custom category its owner deleted stays on the events that already had it, but cannot be chosen again
    if (category.ownerId && category.isActive === false)
        return false;
    if (subcategoryId) {
        const sub = (category.subcategories || []).find((x) => String(x._id) === String(subcategoryId));
        if (sub?.ownerId && !isMine(sub.ownerId, viewerId))
            return false;
        if (sub?.ownerId && sub.isActive === false)
            return false;
    }
    return true;
}
exports.categoryService = {
    /** An organizer's own category: only they see it. The name may not repeat anything they can already pick. */
    async createCustomCategory(ownerId, rawName) {
        const name = rawName.trim();
        const pickable = await Category_1.Category.find({ isActive: { $ne: false }, $or: [{ ownerId: null }, { ownerId }] }).select('name').lean();
        const clash = pickable.find((c) => same(c.name, name));
        if (clash)
            throw { statusCode: 409, message: `"${clash.name}" is already in your list. Pick it from the dropdown.` };
        // A name they deleted earlier comes back as the same category, so events that kept it stay linked to it
        const retired = (await Category_1.Category.find({ ownerId, isActive: false })).find((c) => same(c.name, name));
        if (retired) {
            retired.name = name;
            retired.isActive = true;
            await retired.save();
            return viewFor(retired, ownerId);
        }
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
        const mineOrPlatform = category.subcategories.filter((s) => (!s.ownerId || isMine(s.ownerId, ownerId)) && same(s.name, name));
        const clash = mineOrPlatform.find((s) => s.isActive !== false);
        if (clash)
            throw { statusCode: 409, message: `"${clash.name}" is already in ${category.name}. Pick it from the dropdown.` };
        // A name they deleted earlier comes back as the same subcategory, so events that kept it stay linked to it
        const retired = mineOrPlatform.find((s) => s.ownerId);
        if (retired) {
            retired.name = name;
            retired.isActive = true;
        }
        else {
            category.subcategories.push({ name, isActive: true, ownerId });
        }
        await category.save();
        return viewFor(category, ownerId);
    },
    /**
     * An organizer removing their own custom category. It stops being offered, while events that already use it keep it (their cards
     * and reports still show its name). Their templates filed under it become general templates, because choosing one must not fill a
     * category that is no longer available into a new event.
     */
    async deleteCustomCategory(ownerId, categoryId) {
        if (!mongoose_1.default.Types.ObjectId.isValid(categoryId))
            throw new Error('CATEGORY_NOT_FOUND');
        const category = await Category_1.Category.findOne({ _id: categoryId, ownerId, isActive: { $ne: false } });
        if (!category)
            throw new Error('CATEGORY_NOT_FOUND');
        category.isActive = false;
        await category.save();
        await Template_1.Template.updateMany({ ownerId, categoryId: category._id }, { $unset: { categoryId: 1, subcategoryId: 1 } });
        return viewFor(category, ownerId);
    },
    /** The same for one of their own subcategories, under the platform's category or their own. The platform's subcategories are not theirs to remove. */
    async deleteCustomSubcategory(ownerId, categoryId, subcategoryId) {
        if (!mongoose_1.default.Types.ObjectId.isValid(categoryId) || !mongoose_1.default.Types.ObjectId.isValid(subcategoryId))
            throw new Error('CATEGORY_NOT_FOUND');
        const category = await Category_1.Category.findById(categoryId);
        const sub = category?.subcategories.find((s) => String(s._id) === subcategoryId);
        if (!category || !sub || !isMine(sub.ownerId, ownerId) || sub.isActive === false)
            throw new Error('CATEGORY_NOT_FOUND');
        sub.isActive = false;
        await category.save();
        await Template_1.Template.updateMany({ ownerId, subcategoryId: sub._id }, { $unset: { subcategoryId: 1 } });
        return viewFor(category, ownerId);
    },
    async createCategory(data) {
        const name = String(data.name || '').trim();
        // Organizers' custom categories are private and do not reserve a name on the platform's list
        const existing = await Category_1.Category.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i'), ownerId: null });
        if (existing) {
            throw { statusCode: 409, message: `A category named "${existing.name}" already exists` };
        }
        try {
            const created = await category_repository_1.categoryRepository.create({ ...data, name });
            // a category the administrators add is available to every organizer: they are told
            await alert_service_1.alertService.notifyAllOrganizers({ type: 'CATEGORY', title: 'New event category', message: `The category "${name}" is now available when you create an event.`, entityType: 'Category', entityId: created._id });
            return created;
        }
        catch (e) {
            // only reachable until scripts/migrate-category-uniqueness.js has replaced the old index
            if (e?.code === 11000)
                throw { statusCode: 409, message: 'That name is not available. Please use a different one.' };
            throw e;
        }
    },
    // Appends one subcategory. Existing subcategories keep their ids, so templates and events that
    // reference them stay valid (rewriting the whole array would mint new ids).
    async addSubcategory(id, rawName) {
        const name = rawName.trim();
        const category = await Category_1.Category.findById(id);
        if (!category)
            throw new Error('CATEGORY_NOT_FOUND');
        if (category.subcategories.some((s) => !s.ownerId && same(s.name, name))) {
            throw { statusCode: 409, message: `"${name}" already exists in ${category.name}` };
        }
        category.subcategories.push({ name, isActive: true });
        await category.save();
        await alert_service_1.alertService.notifyAllOrganizers({ type: 'CATEGORY', title: 'New event subcategory', message: `"${name}" was added under ${category.name}. You can choose it when you create an event.`, entityType: 'Category', entityId: category._id });
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
