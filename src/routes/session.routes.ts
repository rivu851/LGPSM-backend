import { auditAction } from '../middlewares/auditAction';
import { Router, Request, Response, NextFunction } from 'express';
import { sessionController } from '../controllers/session.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { createSessionSchema, updateSessionSchema } from '../validators/session.validator';
import { ZodSchema } from 'zod';

const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed: any = schema.parse({ body: req.body });
    req.body = { ...req.body, ...parsed.body };
    next();
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'Validation Error', message: err.issues?.[0]?.message || 'Invalid input data', details: err.issues ?? err.errors });
  }
};

export const eventSessionRoutes = Router({ mergeParams: true });
eventSessionRoutes.use(authenticate);

eventSessionRoutes.post('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(createSessionSchema), auditAction({ action: 'SESSION_CREATE', entityType: 'Session', eventParam: 'eventId' }), sessionController.createSession);
// SYSTEM_USER may read the sessions of events they are assigned to (for check-in)
eventSessionRoutes.get('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER, Role.SYSTEM_USER), sessionController.getSessions);

export const sessionRoutes = Router();
sessionRoutes.use(authenticate);

sessionRoutes.get('/:sessionId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), sessionController.getSessionById);
sessionRoutes.patch('/:sessionId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(updateSessionSchema), auditAction({ action: 'SESSION_UPDATE', entityType: 'Session', entityParam: 'sessionId', eventOf: 'Session' }), sessionController.updateSession);
sessionRoutes.delete('/:sessionId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), auditAction({ action: 'SESSION_DELETE', entityType: 'Session', entityParam: 'sessionId', eventOf: 'Session', critical: true }), sessionController.deleteSession);
