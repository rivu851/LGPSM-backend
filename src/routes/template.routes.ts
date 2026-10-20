import { Router, Request, Response, NextFunction } from 'express';
import { templateController } from '../controllers/template.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { createTemplateSchema, updateTemplateSchema, previewTemplateCardSchema } from '../validators/template.validator';
import { cardPreviewLimiter } from '../middlewares/rateLimiter';

const router = Router();

const validate = (schema: any) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ success: false, errors: result.error.format() });
  }
  req.body = result.data;
  next();
};

router.use(authenticate);

// List/View templates for Organizers & Admins
router.get('/', authorizeRoles(Role.ORGANIZER, Role.ADMIN), templateController.getTemplates);
// The designers' default templates: preview what would be created, then install (admin only)
router.get('/defaults', authorizeRoles(Role.ADMIN), templateController.previewDefaults);
router.post('/defaults', authorizeRoles(Role.ADMIN), templateController.installDefaults);

// The card an event gets when no template is chosen: the design that suits its type (live preview in the Add Event form)
router.post('/preview', authorizeRoles(Role.ORGANIZER, Role.ADMIN), cardPreviewLimiter, validate(previewTemplateCardSchema), templateController.previewCard);
// The card a template makes for the event being entered (live preview in the Add Event form)
router.post('/:id/preview', authorizeRoles(Role.ORGANIZER, Role.ADMIN), cardPreviewLimiter, validate(previewTemplateCardSchema), templateController.previewCard);

router.get('/:id', authorizeRoles(Role.ORGANIZER, Role.ADMIN), templateController.getTemplateById);

// Admin-only template management
router.post('/', authorizeRoles(Role.ADMIN), validate(createTemplateSchema), templateController.createTemplate);
router.patch('/:id', authorizeRoles(Role.ADMIN), validate(updateTemplateSchema), templateController.updateTemplate);
router.delete('/:id', authorizeRoles(Role.ADMIN), templateController.deleteTemplate);

export default router;
