"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryController = void 0;
const category_service_1 = require("../services/category.service");
exports.categoryController = {
    async createCategory(req, res) {
        try {
            const category = await category_service_1.categoryService.createCategory(req.body);
            return res.status(201).json({ success: true, data: category });
        }
        catch (error) {
            if (error?.statusCode)
                return res.status(error.statusCode).json({ success: false, message: error.message });
            return res.status(400).json({ success: false, error: 'Bad Request', message: error.message });
        }
    },
    async addSubcategory(req, res) {
        try {
            const category = await category_service_1.categoryService.addSubcategory(req.params.id, req.body.name);
            return res.status(201).json({ success: true, data: category });
        }
        catch (error) {
            if (error?.statusCode)
                return res.status(error.statusCode).json({ success: false, message: error.message });
            if (error.message === 'CATEGORY_NOT_FOUND')
                return res.status(404).json({ success: false, message: 'Category not found' });
            return res.status(400).json({ success: false, message: error.message });
        }
    },
    async getCategories(req, res) {
        try {
            const activeOnly = req.query.activeOnly !== 'false';
            const categories = await category_service_1.categoryService.getCategories(activeOnly);
            return res.status(200).json({ success: true, data: categories });
        }
        catch (error) {
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    },
    async getCategoryById(req, res) {
        try {
            const category = await category_service_1.categoryService.getCategoryById(req.params.id);
            return res.status(200).json({ success: true, data: category });
        }
        catch (error) {
            if (error.message === 'CATEGORY_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Category not found' });
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    },
    async updateCategory(req, res) {
        try {
            const category = await category_service_1.categoryService.updateCategory(req.params.id, req.body);
            return res.status(200).json({ success: true, data: category });
        }
        catch (error) {
            if (error.message === 'CATEGORY_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Category not found' });
            return res.status(400).json({ error: 'Bad Request', message: error.message });
        }
    },
    async deleteCategory(req, res) {
        try {
            const category = await category_service_1.categoryService.deleteCategory(req.params.id);
            return res.status(200).json({ success: true, message: 'Category deactivated successfully', data: category });
        }
        catch (error) {
            if (error.message === 'CATEGORY_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Category not found' });
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    }
};
