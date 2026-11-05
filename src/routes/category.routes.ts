import { Router, Request, Response, NextFunction } from 'express';
import { categoryController } from '../controllers/category.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { addSubcategorySchema, createCategorySchema, customCategorySchema, customSubcategorySchema, updateCategorySchema } from '../validators/category.validator';

const router = Router();

const validate = (schema: any) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ success: false, message: result.error.issues?.[0]?.message || 'Invalid input data', errors: result.error.format() });
  }
  req.body = result.data;
  next();
};

// Anyone can read the platform's list; a signed-in organizer also gets their own custom categories
const withViewer = (req: Request, res: Response, next: NextFunction) => (req.headers.authorization ? authenticate(req, res, next) : next());

// Organizers' own categories and subcategories (visible to them only)
router.post('/custom', authenticate, authorizeRoles(Role.ORGANIZER), validate(customCategorySchema), categoryController.createCustomCategory);
router.post('/:id/custom-subcategories', authenticate, authorizeRoles(Role.ORGANIZER), validate(customSubcategorySchema), categoryController.addCustomSubcategory);

router.get('/', withViewer, categoryController.getCategories);
router.get('/:id', withViewer, categoryController.getCategoryById);

// Admin-only endpoints
router.post('/', authenticate, authorizeRoles(Role.ADMIN), validate(createCategorySchema), categoryController.createCategory);
router.patch('/:id', authenticate, authorizeRoles(Role.ADMIN), validate(updateCategorySchema), categoryController.updateCategory);
router.post('/:id/subcategories', authenticate, authorizeRoles(Role.ADMIN), validate(addSubcategorySchema), categoryController.addSubcategory);
router.delete('/:id', authenticate, authorizeRoles(Role.ADMIN), categoryController.deleteCategory);

export default router;
