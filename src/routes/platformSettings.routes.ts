import { Router, Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { platformSettingsController } from '../controllers/platformSettings.controller';
import { eventFeaturesSchema, notificationPreferencesSchema, pricingSchema } from '../validators/platformSettings.validator';

const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ success: false, message: result.error.issues[0]?.message || 'Invalid input data' });
  }
  req.body = result.data;
  next();
};

const router = Router();
router.use(authenticate);

// Organizers read event features so the event form only offers what the admin allows
router.get('/event-features', authorizeRoles(Role.ADMIN, Role.ORGANIZER), platformSettingsController.getEventFeatures);
router.put('/event-features', authorizeRoles(Role.ADMIN), validate(eventFeaturesSchema), platformSettingsController.updateEventFeatures);
router.get('/notifications', authorizeRoles(Role.ADMIN), platformSettingsController.getNotificationPreferences);
router.put('/notifications', authorizeRoles(Role.ADMIN), validate(notificationPreferencesSchema), platformSettingsController.updateNotificationPreferences);
router.get('/pricing', authorizeRoles(Role.ADMIN), platformSettingsController.getPricing);
router.put('/pricing', authorizeRoles(Role.ADMIN), validate(pricingSchema), platformSettingsController.updatePricing);

export default router;
