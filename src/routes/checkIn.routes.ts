import { auditAction } from '../middlewares/auditAction';
import { Router, Request, Response, NextFunction } from 'express';
import { checkInController } from '../controllers/checkIn.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { scanCheckInSchema, manualCheckInSchema } from '../validators/checkIn.validator';
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

export const checkInRoutes = Router();
checkInRoutes.use(authenticate);

checkInRoutes.post(
  '/scan',
  authorizeRoles(Role.ORGANIZER, Role.SYSTEM_USER, Role.ADMIN),
  validate(scanCheckInSchema),
  auditAction({ action: 'CHECKIN_SCAN', entityType: 'CheckIn' }),
  checkInController.scanCheckIn
);

checkInRoutes.post(
  '/manual',
  authorizeRoles(Role.ORGANIZER, Role.SYSTEM_USER, Role.ADMIN),
  validate(manualCheckInSchema),
  auditAction({ action: 'CHECKIN_MANUAL', entityType: 'CheckIn' }),
  checkInController.manualCheckIn
);

export const eventCheckInRoutes = Router({ mergeParams: true });
eventCheckInRoutes.use(authenticate);

eventCheckInRoutes.get(
  '/',
  authorizeRoles(Role.ORGANIZER, Role.SYSTEM_USER, Role.ADMIN),
  checkInController.getCheckIns
);

export default checkInRoutes;
