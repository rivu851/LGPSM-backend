import { Router, Request, Response, NextFunction } from 'express';
import { templateController } from '../controllers/template.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { createTemplateSchema, updateTemplateSchema, updateOwnTemplateSchema, previewTemplateCardSchema, renderTemplateForEventSchema } from '../validators/template.validator';
import { cardPreviewLimiter, templateRenderLimiter } from '../middlewares/rateLimiter';
import { Template } from '../models/Template';

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

// A custom template drawn with a real event's details at full size (PNG or JPEG)
router.post('/:id/render', authorizeRoles(Role.ORGANIZER, Role.ADMIN), templateRenderLimiter, validate(renderTemplateForEventSchema), templateController.renderForEvent);

router.get('/:id', authorizeRoles(Role.ORGANIZER, Role.ADMIN), templateController.getTemplateById);

// Admins manage every template. Organizers manage only their own AI templates (the controller scopes them to the
// owner), and with a narrower body: they cannot change ownership, visibility to others or the render engine.
router.post('/', authorizeRoles(Role.ADMIN), validate(createTemplateSchema), templateController.createTemplate);
// Before any body is validated: admins pass; an organizer must own the template. The designers' templates answer 403
// (as before), another organizer's private template answers 404 so its id reveals nothing.
const requireOwnerOrAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if ((req as any).user?.role === Role.ADMIN) return next();
    const template = await Template.findById(req.params.id).select('ownerId isActive').lean();
    if (!template || template.isActive === false) return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
    if (!template.ownerId) return res.status(403).json({ success: false, message: 'Only an admin can change this template' });
    if (String(template.ownerId) !== (req as any).user?.userId) return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
    next();
  } catch (error: any) {
    console.error('Request failed:', error?.message);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
  }
};
const validateByRole = (adminSchema: any, ownerSchema: any) => (req: Request, res: Response, next: NextFunction) =>
  validate((req as any).user?.role === Role.ADMIN ? adminSchema : ownerSchema)(req, res, next);
router.patch('/:id', authorizeRoles(Role.ORGANIZER, Role.ADMIN), requireOwnerOrAdmin, validateByRole(updateTemplateSchema, updateOwnTemplateSchema), templateController.updateTemplate);
router.delete('/:id', authorizeRoles(Role.ORGANIZER, Role.ADMIN), requireOwnerOrAdmin, templateController.deleteTemplate);

export default router;
