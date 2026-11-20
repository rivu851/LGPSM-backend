import { auditAction } from '../middlewares/auditAction';
import { z } from 'zod';
import { User } from '../models/User';
import { platformSettingsService } from '../services/platformSettings.service';
import { Router } from 'express';
import { userController } from '../controllers/user.controller';
import { authenticate } from '../middlewares/authenticate';
import { updateProfileSchema, createUserSchema, updateUserSchema, changePasswordSchema } from '../validators/user.validator';
import { Request, Response, NextFunction } from 'express';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { uploadImage } from '../middlewares/imageUpload';
import { mediaUploadLimiter } from '../middlewares/rateLimiter';

const router = Router();

const validate = (schema: any) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ success: false, errors: result.error.format() });
  }
  req.body = result.data;
  next();
};

// All user routes require authentication
router.use(authenticate);

router.get('/profile', userController.getProfile);
router.patch('/profile', validate(updateProfileSchema), userController.updateProfile);
router.patch('/profile/photo', mediaUploadLimiter, uploadImage, userController.updateProfilePhoto);
router.patch('/me/password', validate(changePasswordSchema), auditAction({ action: 'USER_PASSWORD_CHANGE', entityType: 'User' }), userController.changePassword);

// Endpoint for Admins and Organizers to list users (supports ?role=SYSTEM_USER)
router.get(
  '/',
  authorizeRoles(Role.ADMIN, Role.ORGANIZER),
  userController.getUsers
);

// Endpoint for Admins and Organizers to create sub-users
router.post(
  '/', 
  authorizeRoles(Role.ADMIN, Role.ORGANIZER), 
  validate(createUserSchema), 
  auditAction({ action: 'USER_CREATE', entityType: 'User' }),
  userController.createUser
);

// Endpoint for Admins and Organizers to view a single sub-user
router.get(
  '/:id',
  authorizeRoles(Role.ADMIN, Role.ORGANIZER),
  userController.getUserById
);

// Endpoint for Admins and Organizers to delete sub-users
router.delete(
  '/:id',
  authorizeRoles(Role.ADMIN, Role.ORGANIZER),
  auditAction({ action: 'USER_DELETE', entityType: 'User', entityParam: 'id', critical: true }),
  userController.deleteUser
);

// Endpoint for Admins and Organizers to update sub-users
router.patch(
  '/:id',
  authorizeRoles(Role.ADMIN, Role.ORGANIZER),
  validate(updateUserSchema),
  auditAction({ action: 'USER_UPDATE', entityType: 'User', entityParam: 'id' }),
  userController.updateUser
);

// The per-invitee rate for one organizer: their own rate when an administrator set one, otherwise the platform rate
router.get('/:id/rate', authorizeRoles(Role.ADMIN), async (req, res, next) => {
  try {
    res.json({ success: true, data: await platformSettingsService.rateForOrganizer(req.params.id) });
  } catch (e) { next(e); }
});
router.put(
  '/:id/rate',
  authorizeRoles(Role.ADMIN),
  validate(z.object({ ratePerInvitee: z.number().finite().min(0, 'Rate cannot be negative').max(1000, 'Rate looks too high').nullable() }).strict()),
  auditAction({ action: 'ORGANIZER_RATE_SET', entityType: 'User', entityParam: 'id' }),
  async (req, res, next) => {
    try {
      const target = await User.findOne({ _id: req.params.id, role: Role.ORGANIZER }).select('_id').lean();
      if (!target) return res.status(404).json({ success: false, message: 'Organizer not found' });
      res.json({ success: true, data: await platformSettingsService.setOrganizerRate((req as any).user.userId, String(req.params.id), req.body.ratePerInvitee) });
    } catch (e) { next(e); }
  }
);

// Admin/organizer view of a staff member's event/session assignments
// (organizers only ever see assignments scoped to their own events; see service)
router.get(
  '/:id/assignments',
  authorizeRoles(Role.ADMIN, Role.ORGANIZER),
  userController.getUserAssignments
);

export default router;
