import { Router, Request, Response, NextFunction } from 'express';
import { inviteeController } from '../controllers/invitee.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { createInviteeSchema, updateInviteeSchema, updateSessionAccessSchema, bulkUpdateSessionAccessSchema } from '../validators/invitee.validator';
import { ZodSchema } from 'zod';
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const excelMime = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'].includes(file.mimetype);
    // Some browsers send spreadsheets as a generic binary; the parser still validates the content
    const excelByName = file.mimetype === 'application/octet-stream' && /\.(xlsx|xls)$/i.test(file.originalname);
    if (excelMime || excelByName) {
      cb(null, true);
    } else {
      cb(new Error('Upload an Excel file (.xlsx or .xls)'));
    }
  }
});

const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed: any = schema.parse({ body: req.body });
    req.body = { ...req.body, ...parsed.body };
    next();
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'Validation Error', message: err.issues?.[0]?.message || 'Invalid input data', details: err.issues ?? err.errors });
  }
};

export const eventInviteeRoutes = Router({ mergeParams: true });
eventInviteeRoutes.use(authenticate);

eventInviteeRoutes.post('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(createInviteeSchema), inviteeController.createInvitee);
eventInviteeRoutes.get('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER), inviteeController.getInvitees);
eventInviteeRoutes.put('/session-access/bulk', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(bulkUpdateSessionAccessSchema), inviteeController.bulkUpdateSessionAccess);

// Upload handling
eventInviteeRoutes.post('/import', authorizeRoles(Role.ADMIN, Role.ORGANIZER), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Payload Too Large', message: 'File size exceeds limit', details: [] });
      }
      return res.status(400).json({ error: 'Bad Request', message: err.message, details: [] });
    } else if (err) {
      return res.status(415).json({ error: 'Unsupported Media Type', message: err.message, details: [] });
    }
    next();
  });
}, inviteeController.importExcel);

export const inviteeRoutes = Router();
inviteeRoutes.use(authenticate);

inviteeRoutes.get('/:inviteeId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), inviteeController.getInviteeById);
inviteeRoutes.patch('/:inviteeId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(updateInviteeSchema), inviteeController.updateInvitee);
inviteeRoutes.delete('/:inviteeId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), inviteeController.deleteInvitee);
inviteeRoutes.put('/:inviteeId/session-access', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(updateSessionAccessSchema), inviteeController.updateSessionAccess);
