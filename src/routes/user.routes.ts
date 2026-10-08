import { Router } from 'express';
import { userController } from '../controllers/user.controller';
import { authenticate } from '../middlewares/authenticate';
import { updateProfileSchema, createUserSchema, updateUserSchema, changePasswordSchema } from '../validators/user.validator';
import { Request, Response, NextFunction } from 'express';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';

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
router.patch('/me/password', validate(changePasswordSchema), userController.changePassword);

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
  userController.createUser
);

// Endpoint for Admins and Organizers to delete sub-users
router.delete(
  '/:id',
  authorizeRoles(Role.ADMIN, Role.ORGANIZER),
  userController.deleteUser
);

// Endpoint for Admins and Organizers to update sub-users
router.patch(
  '/:id',
  authorizeRoles(Role.ADMIN, Role.ORGANIZER),
  validate(updateUserSchema),
  userController.updateUser
);

// Admin/organizer view of a staff member's event/session assignments
// (organizers only ever see assignments scoped to their own events; see service)
router.get(
  '/:id/assignments',
  authorizeRoles(Role.ADMIN, Role.ORGANIZER),
  userController.getUserAssignments
);

export default router;
