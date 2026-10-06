import { Router, Request, Response, NextFunction } from 'express';
import { eventController } from '../controllers/event.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { createEventSchema, updateEventSchema } from '../validators/event.validator';
import { ZodSchema } from 'zod';

const router = Router();

// Zod validation middleware wrapper
const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed: any = schema.parse({ body: req.body });
    req.body = { ...req.body, ...parsed.body };
    next();
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'Validation Error', message: err.issues?.[0]?.message || 'Invalid input data', details: err.issues ?? err.errors });
  }
};

// All event routes require authentication
router.use(authenticate);

// Cleanup route - ADMIN ONLY
router.post('/:eventId/cleanup', authorizeRoles(Role.ADMIN), eventController.cleanupEventData);

// Routes accessible to ADMIN and ORGANIZER
router.post('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(createEventSchema), eventController.createEvent);
router.get('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER), eventController.getEvents);
// SYSTEM_USER may read details of events they are assigned to (for check-in)
router.get('/:eventId', authorizeRoles(Role.ADMIN, Role.ORGANIZER, Role.SYSTEM_USER), eventController.getEventById);
router.patch('/:eventId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(updateEventSchema), eventController.updateEvent);
router.delete('/:eventId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), eventController.deleteEvent);

export default router;
