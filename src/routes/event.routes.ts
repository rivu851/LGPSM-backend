import { auditAction } from '../middlewares/auditAction';
import { Router, Request, Response, NextFunction } from 'express';
import { eventController } from '../controllers/event.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { createEventSchema, updateEventSchema, updateAdmissionSchema } from '../validators/event.validator';
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
router.post('/:eventId/cleanup', authorizeRoles(Role.ADMIN), auditAction({ action: 'EVENT_PURGE', entityType: 'Event', entityParam: 'eventId', critical: true, describe: 'Permanent deletion of event operational data', meta: (_r, b) => ({ cleanedCounts: b?.cleanedCounts }) }), eventController.cleanupEventData);

// Close (complete) an event without deleting anything - ADMIN or the owning ORGANIZER
// Change when guests may be admitted (allowed after invitations went out; audited, fails closed)
router.patch('/:eventId/admission', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(updateAdmissionSchema), auditAction({ action: 'EVENT_ADMISSION_UPDATE', entityType: 'Event', entityParam: 'eventId', critical: true, describe: 'Check-in window changed', meta: (req) => ({ opensAt: (req.body as any)?.opensAt, closesAt: (req.body as any)?.closesAt }) }), eventController.updateAdmission);
router.post('/:eventId/close', authorizeRoles(Role.ADMIN, Role.ORGANIZER), auditAction({ action: 'EVENT_CLOSE', entityType: 'Event', entityParam: 'eventId', critical: true, describe: 'Event closed (data retained)' }), eventController.closeEvent);

// Routes accessible to ADMIN and ORGANIZER
router.post('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(createEventSchema), auditAction({ action: 'EVENT_CREATE', entityType: 'Event' }), eventController.createEvent);
router.get('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER), eventController.getEvents);
// SYSTEM_USER may read details of events they are assigned to (for check-in)
router.get('/:eventId', authorizeRoles(Role.ADMIN, Role.ORGANIZER, Role.SYSTEM_USER), eventController.getEventById);
router.patch('/:eventId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(updateEventSchema), auditAction({ action: 'EVENT_UPDATE', entityType: 'Event', entityParam: 'eventId' }), eventController.updateEvent);
router.delete('/:eventId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), auditAction({ action: 'EVENT_CANCEL', entityType: 'Event', entityParam: 'eventId', critical: true, describe: 'Event cancelled' }), eventController.deleteEvent);

export default router;
