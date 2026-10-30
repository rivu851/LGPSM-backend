import { auditAction } from '../middlewares/auditAction';
import { Router, Request, Response, NextFunction } from 'express';
import { systemUserAssignmentController } from '../controllers/systemUserAssignment.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { createAssignmentSchema, updateAssignmentSchema } from '../validators/systemUserAssignment.validator';
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

export const eventAssignmentRoutes = Router({ mergeParams: true });
eventAssignmentRoutes.use(authenticate);

eventAssignmentRoutes.post('/', authorizeRoles(Role.ORGANIZER, Role.ADMIN), validate(createAssignmentSchema), auditAction({ action: 'STAFF_ASSIGN', entityType: 'SystemUserAssignment', eventParam: 'eventId' }), systemUserAssignmentController.createAssignment);
eventAssignmentRoutes.get('/', authorizeRoles(Role.ORGANIZER, Role.ADMIN), systemUserAssignmentController.getAssignmentsByEvent);

export const assignmentRoutes = Router();
assignmentRoutes.use(authenticate);

assignmentRoutes.patch('/:assignmentId', authorizeRoles(Role.ORGANIZER, Role.ADMIN), validate(updateAssignmentSchema), auditAction({ action: 'STAFF_ASSIGNMENT_UPDATE', entityType: 'SystemUserAssignment', entityParam: 'assignmentId', eventOf: 'SystemUserAssignment' }), systemUserAssignmentController.updateAssignment);
assignmentRoutes.delete('/:assignmentId', authorizeRoles(Role.ORGANIZER, Role.ADMIN), auditAction({ action: 'STAFF_UNASSIGN', entityType: 'SystemUserAssignment', entityParam: 'assignmentId', eventOf: 'SystemUserAssignment', critical: true }), systemUserAssignmentController.deleteAssignment);

export const myAssignmentRoutes = Router();
myAssignmentRoutes.use(authenticate);
myAssignmentRoutes.get('/', authorizeRoles(Role.SYSTEM_USER), systemUserAssignmentController.getMyAssignments);
