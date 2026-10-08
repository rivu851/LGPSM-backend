"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryService = void 0;
const category_repository_1 = require("../repositories/category.repository");
const Category_1 = require("../models/Category");
const escapeRegex = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
exports.categoryService = {
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
    async getCategories(activeOnly = true) {
        return await category_repository_1.categoryRepository.findAll(activeOnly);
    },
    async getCategoryById(id) {
        const category = await category_repository_1.categoryRepository.findById(id);
        if (!category)
            throw new Error('CATEGORY_NOT_FOUND');
        return category;
    },
    async updateCategory(id, updateData) {
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
