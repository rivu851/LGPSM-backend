import { auditAction } from '../middlewares/auditAction';
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

eventInviteeRoutes.post('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(createInviteeSchema), auditAction({ action: 'INVITEE_CREATE', entityType: 'Invitee', eventParam: 'eventId' }), inviteeController.createInvitee);
// SYSTEM_USER may read invitees of events they are assigned to (for check-in)
eventInviteeRoutes.get('/', authorizeRoles(Role.ADMIN, Role.ORGANIZER, Role.SYSTEM_USER), inviteeController.getInvitees);
// Access-pass history and message retry: the event's owner or an admin (never staff)
eventInviteeRoutes.get('/sets', authorizeRoles(Role.ADMIN, Role.ORGANIZER), inviteeController.getInviteeSets);
eventInviteeRoutes.get('/sets/:setId/members', authorizeRoles(Role.ADMIN, Role.ORGANIZER), inviteeController.getSetMembers);
// Set-aside guests: the owner organizer and admins only, never System Users
eventInviteeRoutes.get('/set-aside', authorizeRoles(Role.ADMIN, Role.ORGANIZER), inviteeController.getSetAside);
eventInviteeRoutes.post('/set-aside/restore', authorizeRoles(Role.ADMIN, Role.ORGANIZER), auditAction({ action: 'INVITEE_RESTORE', entityType: 'Invitee', eventParam: 'eventId', describe: 'Set-aside guests restored', meta: (_req, body) => { const d = body?.data || {}; return { restored: d.restored, refused: d.refused, alreadyActive: d.alreadyActive, notFound: d.notFound }; } }), inviteeController.restoreSetAside);
eventInviteeRoutes.get('/credential-events', authorizeRoles(Role.ADMIN, Role.ORGANIZER), inviteeController.getCredentialHistory);
eventInviteeRoutes.post('/pass-notices/retry', authorizeRoles(Role.ADMIN, Role.ORGANIZER), auditAction({ action: 'PASS_NOTICES_RETRY', entityType: 'Event', eventParam: 'eventId', describe: 'Access-pass messages retried', meta: (req) => ({ includeUnknown: (req.body as any)?.includeUnknown === true }) }), inviteeController.retryPassNotices);
eventInviteeRoutes.put('/session-access/bulk', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(bulkUpdateSessionAccessSchema), auditAction({ action: 'INVITEE_SESSION_ACCESS_BULK', entityType: 'Invitee', eventParam: 'eventId' }), inviteeController.bulkUpdateSessionAccess);

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
}, auditAction({ action: 'INVITEE_IMPORT', entityType: 'Invitee', eventParam: 'eventId', describe: 'Invitee list imported', meta: (_req, body) => { const d = body?.data || {}; return { mode: d.mode, setId: d.setId, imported: d.imported, archived: d.archived, alreadyInvited: d.alreadyInvited, preservedSets: d.preservedSets, rejected: d.rejected }; } }), inviteeController.importExcel);

export const inviteeRoutes = Router();
inviteeRoutes.use(authenticate);

inviteeRoutes.get('/:inviteeId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), inviteeController.getInviteeById);
inviteeRoutes.patch('/:inviteeId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(updateInviteeSchema), auditAction({ action: 'INVITEE_UPDATE', entityType: 'Invitee', entityParam: 'inviteeId', eventOf: 'Invitee' }), inviteeController.updateInvitee);
inviteeRoutes.delete('/:inviteeId', authorizeRoles(Role.ADMIN, Role.ORGANIZER), auditAction({ action: 'INVITEE_DELETE', entityType: 'Invitee', entityParam: 'inviteeId', eventOf: 'Invitee', critical: true }), inviteeController.deleteInvitee);
// Individual access pass: revoke / replace (critical: refused if the audit record cannot be written). The reason category is
// stored; the free-text note is not copied into the audit entry.
inviteeRoutes.post('/:inviteeId/revoke', authorizeRoles(Role.ADMIN, Role.ORGANIZER), auditAction({ action: 'CREDENTIAL_REVOKE', entityType: 'Invitee', entityParam: 'inviteeId', eventOf: 'Invitee', critical: true, describe: 'Access pass revoked', meta: (req) => ({ category: (req.body as any)?.category }) }), inviteeController.revokeCredential);
inviteeRoutes.post('/:inviteeId/replace', authorizeRoles(Role.ADMIN, Role.ORGANIZER), auditAction({ action: 'CREDENTIAL_REPLACE', entityType: 'Invitee', entityParam: 'inviteeId', eventOf: 'Invitee', critical: true, describe: 'Access pass replaced', meta: (req) => ({ category: (req.body as any)?.category, reviewConfirmed: (req.body as any)?.reviewConfirmed === true }) }), inviteeController.replaceCredential);
inviteeRoutes.put('/:inviteeId/session-access', authorizeRoles(Role.ADMIN, Role.ORGANIZER), validate(updateSessionAccessSchema), auditAction({ action: 'INVITEE_SESSION_ACCESS_UPDATE', entityType: 'Invitee', entityParam: 'inviteeId', eventOf: 'Invitee' }), inviteeController.updateSessionAccess);
