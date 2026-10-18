import { Router, Request, Response, NextFunction } from 'express';
import { publicInvitationController } from '../controllers/publicInvitation.controller';
import { submitRsvpSchema } from '../validators/publicInvitation.validator';
import { ZodSchema } from 'zod';
import { publicInvitationLimiter } from '../middlewares/rateLimiter';

const router = Router();

router.use(publicInvitationLimiter);

const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed: any = schema.parse({ body: req.body });
    req.body = { ...req.body, ...parsed.body };
    next();
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'Validation Error', message: err.issues?.[0]?.message || 'Invalid input data', details: err.issues ?? err.errors });
  }
};

// GET /api/v1/public/invitations/:token
router.get('/:token', publicInvitationController.getPublicInvitation);

// POST /api/v1/public/invitations/:token/rsvp
router.post('/:token/rsvp', validate(submitRsvpSchema), publicInvitationController.submitRsvp);

export default router;
