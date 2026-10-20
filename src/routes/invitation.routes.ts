import { Router, Request, Response, NextFunction } from 'express';
import { invitationController } from '../controllers/invitation.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { sendInvitationSchema, resendInvitationSchema } from '../validators/invitation.validator';
import { ZodSchema } from 'zod';

const router = Router({ mergeParams: true });

const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed: any = schema.parse({ body: req.body });
    req.body = { ...req.body, ...parsed.body };
    next();
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'Validation Error', message: err.issues?.[0]?.message || 'Invalid input data', details: err.issues ?? err.errors });
  }
};

router.use(authenticate);

// POST /api/v1/events/:eventId/invitations/send
router.post('/send', authorizeRoles(Role.ORGANIZER, Role.ADMIN), validate(sendInvitationSchema), invitationController.sendInvitations);

// POST /api/v1/events/:eventId/invitations/resend
router.post('/resend', authorizeRoles(Role.ORGANIZER, Role.ADMIN), validate(resendInvitationSchema), invitationController.resendInvitations);

// GET /api/v1/events/:eventId/invitations/preview
router.get('/preview', authorizeRoles(Role.ORGANIZER, Role.ADMIN), invitationController.previewInvitationCard);

// GET /api/v1/events/:eventId/invitations
router.get('/', authorizeRoles(Role.ORGANIZER, Role.ADMIN), invitationController.getInvitations);

// DELETE /api/v1/events/:eventId/invitations/history  (hides delivery history; records are kept)
router.delete('/history', authorizeRoles(Role.ORGANIZER, Role.ADMIN), invitationController.clearHistory);

export default router;
