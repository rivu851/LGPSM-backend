import { Router, Request, Response, NextFunction } from 'express';
import { categoryController } from '../controllers/category.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { addSubcategorySchema, createCategorySchema, updateCategorySchema } from '../validators/category.validator';

const router = Router();

const validate = (schema: any) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ success: false, message: result.error.issues?.[0]?.message || 'Invalid input data', errors: result.error.format() });
  }
  req.body = result.data;
  next();
};

// Public/Auth endpoints
router.get('/', categoryController.getCategories);
router.get('/:id', categoryController.getCategoryById);

// Admin-only endpoints
router.post('/', authenticate, authorizeRoles(Role.ADMIN), validate(createCategorySchema), categoryController.createCategory);
router.patch('/:id', authenticate, authorizeRoles(Role.ADMIN), validate(updateCategorySchema), categoryController.updateCategory);
router.post('/:id/subcategories', authenticate, authorizeRoles(Role.ADMIN), validate(addSubcategorySchema), categoryController.addSubcategory);
router.delete('/:id', authenticate, authorizeRoles(Role.ADMIN), categoryController.deleteCategory);

export default router;
