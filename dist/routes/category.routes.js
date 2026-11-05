"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const category_controller_1 = require("../controllers/category.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const category_validator_1 = require("../validators/category.validator");
const router = (0, express_1.Router)();
const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        return res.status(400).json({ success: false, message: result.error.issues?.[0]?.message || 'Invalid input data', errors: result.error.format() });
    }
    req.body = result.data;
    next();
};
// Anyone can read the platform's list; a signed-in organizer also gets their own custom categories
const withViewer = (req, res, next) => (req.headers.authorization ? (0, authenticate_1.authenticate)(req, res, next) : next());
// Organizers' own categories and subcategories (visible to them only)
router.post('/custom', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER), validate(category_validator_1.customCategorySchema), category_controller_1.categoryController.createCustomCategory);
router.post('/:id/custom-subcategories', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER), validate(category_validator_1.customSubcategorySchema), category_controller_1.categoryController.addCustomSubcategory);
router.get('/', withViewer, category_controller_1.categoryController.getCategories);
router.get('/:id', withViewer, category_controller_1.categoryController.getCategoryById);
// Admin-only endpoints
router.post('/', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), validate(category_validator_1.createCategorySchema), category_controller_1.categoryController.createCategory);
router.patch('/:id', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), validate(category_validator_1.updateCategorySchema), category_controller_1.categoryController.updateCategory);
router.post('/:id/subcategories', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), validate(category_validator_1.addSubcategorySchema), category_controller_1.categoryController.addSubcategory);
router.delete('/:id', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), category_controller_1.categoryController.deleteCategory);
exports.default = router;
