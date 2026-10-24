import { Router, Request, Response, NextFunction } from 'express';
import { templateGenerationController } from '../controllers/templateGeneration.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { createGenerationSchema, changeGenerationSchema, saveVariantSchema } from '../validators/template.validator';
import { templateGenerationLimiter, templateGenerationReadLimiter } from '../middlewares/rateLimiter';

const router = Router();

const validate = (schema: any) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: result.error.issues[0]?.message || 'Invalid request', errors: result.error.format() });
  }
  req.body = result.data;
  next();
};
const validIndex = (req: Request, res: Response, next: NextFunction) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index > 2) return res.status(400).json({ success: false, code: 'INVALID_REQUEST', message: 'Invalid design number' });
  next();
};

// Organizers generate for themselves; admins for themselves and can inspect anyone's. Staff accounts have no access.
router.use(authenticate, authorizeRoles(Role.ORGANIZER, Role.ADMIN));

router.get('/options', templateGenerationReadLimiter, templateGenerationController.options);
router.get('/', templateGenerationReadLimiter, templateGenerationController.list);
router.post('/', templateGenerationLimiter, validate(createGenerationSchema), templateGenerationController.create);
// change a design that is already saved as a template (the owner's, or any for an admin)
router.post('/from-template/:templateId/edit', templateGenerationLimiter, validate(changeGenerationSchema), templateGenerationController.editSaved);
router.get('/:id', templateGenerationReadLimiter, templateGenerationController.get);
router.delete('/:id', templateGenerationController.remove);
router.post('/:id/variants/:index/edit', templateGenerationLimiter, validIndex, validate(changeGenerationSchema), templateGenerationController.edit);
router.post('/:id/variants/:index/variations', templateGenerationLimiter, validIndex, validate(changeGenerationSchema), templateGenerationController.variations);
router.post('/:id/variants/:index/save', validIndex, validate(saveVariantSchema), templateGenerationController.save);

export default router;
