import { Request, Response, NextFunction } from 'express';
import { credentialService } from '../services/credential.service';
import { passNoticeService } from '../services/passNotice.service';
import { inviteeService } from '../services/invitee.service';
import { inviteeSetService } from '../services/inviteeSet.service';
import { ImportMode } from '../models/InviteeSet';

const CREDENTIAL_REFUSALS: Record<string, { status: number; message: string }> = {
  INVITEE_NOT_FOUND: { status: 404, message: 'Guest not found or inaccessible' },
  EVENT_NOT_FOUND: { status: 404, message: 'Event not found or inaccessible' },
  FORBIDDEN: { status: 403, message: 'You are not allowed to manage access passes' },
  EVENT_NOT_ACTIVE: { status: 409, message: 'Access passes can only be changed while the event is published.' },
  NOT_ISSUED: { status: 409, message: 'This guest has no access pass yet. Send the invitation first.' },
  CREDENTIAL_EXPIRED: { status: 409, message: 'The admission window has closed, so a new pass would not work either.' },
  REPLACEMENT_NOT_ALLOWED: { status: 409, message: 'This pass was revoked because access was withdrawn, so it cannot be replaced from here.' },
  REVIEW_REQUIRED: { status: 409, message: 'This pass was revoked for another reason. Confirm that you have reviewed it before replacing it.' },
  NOT_ELIGIBLE: { status: 409, message: 'This guest is not eligible for admission under the event\'s RSVP rules, so no new pass was issued.' },
  NO_DELIVERY_CHANNEL: { status: 409, message: 'No earlier invitation reached this guest on any channel, so a replacement could not be delivered. Send the invitation instead.' },
  CONFLICT: { status: 409, message: 'The pass changed while you were replacing it. Reload and try again; nothing was changed.' },
  CARD_RENDER_FAILED: { status: 500, message: 'The new pass could not be prepared. The current pass is unchanged.' }
};

function sendSetError(res: Response, next: NextFunction, error: any): void {
  if (error?.statusCode && error.statusCode < 500) {
    res.status(error.statusCode).json({ success: false, ...(error.code ? { code: error.code } : {}), message: error.message });
    return;
  }
  next(error);
}

function sendCredentialError(res: Response, next: NextFunction, error: any): void {
  if (error?.message === 'INVALID_REASON') {
    res.status(400).json({ success: false, error: 'Bad Request', code: 'INVALID_REASON', message: error.detail || 'Invalid reason' });
    return;
  }
  const refusal = CREDENTIAL_REFUSALS[error?.message];
  if (refusal) {
    res.status(refusal.status).json({ success: false, code: error.message, message: refusal.message });
    return;
  }
  next(error);
}

const channelsOf = (notice: any) => notice ? { email: notice.email?.status, whatsapp: notice.whatsapp?.status } : undefined;

export const inviteeController = {
  async revokeCredential(req: Request, res: Response, next: NextFunction) {
    try {
      const r = await credentialService.revoke((req as any).user, req.params.inviteeId as string, req.body || {});
      if (!r.alreadyRevoked && (r as any).notice) await credentialService.startNotices((r as any).notice);
      res.status(200).json({ success: true, data: { inviteeId: req.params.inviteeId, credentialStatus: 'REVOKED', alreadyRevoked: r.alreadyRevoked, notice: channelsOf((r as any).notice) } });
    } catch (error) { sendCredentialError(res, next, error); }
  },

  async replaceCredential(req: Request, res: Response, next: NextFunction) {
    try {
      const r = await credentialService.replace((req as any).user, req.params.inviteeId as string, req.body || {});
      res.status(200).json({ success: true, data: { inviteeId: req.params.inviteeId, credentialStatus: 'ACTIVE', version: (r.credentialEvent as any).version, notice: channelsOf(r.notice) } });
    } catch (error) { sendCredentialError(res, next, error); }
  },

  async getCredentialHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await credentialService.history((req as any).user, req.params.eventId as string, { inviteeId: typeof req.query.inviteeId === 'string' ? req.query.inviteeId : undefined });
      res.status(200).json({ success: true, data });
    } catch (error) { sendCredentialError(res, next, error); }
  },

  async getInviteeSets(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json({ success: true, data: await inviteeSetService.list((req as any).user, req.params.eventId as string) });
    } catch (error) { sendSetError(res, next, error); }
  },

  async getSetMembers(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await inviteeSetService.members((req as any).user, req.params.eventId as string, req.params.setId as string, parseInt(req.query.page as string) || 1, parseInt(req.query.limit as string) || 50);
      res.status(200).json({ success: true, data });
    } catch (error) { sendSetError(res, next, error); }
  },

  async getSetAside(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await inviteeSetService.setAside((req as any).user, req.params.eventId as string, { q: typeof req.query.q === 'string' ? req.query.q : undefined, page: parseInt(req.query.page as string) || 1, limit: parseInt(req.query.limit as string) || 50 });
      res.status(200).json({ success: true, data });
    } catch (error) { sendSetError(res, next, error); }
  },

  async restoreSetAside(req: Request, res: Response, next: NextFunction) {
    try {
      const ids = Array.isArray(req.body?.inviteeIds) ? req.body.inviteeIds.filter((x: unknown) => typeof x === 'string') : [];
      const data = await inviteeSetService.restore((req as any).user, req.params.eventId as string, ids);
      res.status(200).json({ success: true, data });
    } catch (error) { sendSetError(res, next, error); }
  },

  async retryPassNotices(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      // same authorization as reading the history: the owner or an admin of this event
      await credentialService.history(user, req.params.eventId as string, { limit: 1 });
      const totals = await passNoticeService.retry(req.params.eventId, { inviteeId: typeof req.body?.inviteeId === 'string' ? req.body.inviteeId : undefined, includeUnknown: req.body?.includeUnknown === true });
      res.status(200).json({ success: true, data: { attempted: totals } });
    } catch (error) { sendCredentialError(res, next, error); }
  },

  async createInvitee(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      
      const invitee = await inviteeService.createInvitee(eventId, organizerId, req.body, (req as any).user.role);
      
      res.status(201).json({ success: true, data: invitee });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else if (error.message === 'DUPLICATE_INVITEE') {
        res.status(409).json({ error: 'Conflict', message: 'Invitee already exists', details: [] });
      } else {
        next(error);
      }
    }
  },

  async getInvitees(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);

      const checkInStatusParam = req.query.checkInStatus as string | undefined;
      const checkInStatus: 'CHECKED_IN' | 'PENDING' | undefined =
        checkInStatusParam === 'CHECKED_IN' || checkInStatusParam === 'PENDING' ? checkInStatusParam : undefined;

      const options = {
        page,
        limit,
        rsvpStatus: req.query.rsvpStatus as string,
        invitationStatus: req.query.invitationStatus as string,
        search: req.query.search as string,
        sessionId: req.query.sessionId as string | undefined,
        checkInStatus,
        sessionAccessId: req.query.sessionAccessId as string | undefined,
        invitation: req.query.invitation === 'SENT' || req.query.invitation === 'NOT_SENT' ? (req.query.invitation as 'SENT' | 'NOT_SENT') : undefined,
      };

      const result = await inviteeService.getInvitees(eventId, organizerId, options, (req as any).user.role);
      
      res.status(200).json({
        success: true,
        data: result.invitees,
        meta: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) || 1 }
      });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else {
        next(error);
      }
    }
  },

  async getInviteeById(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const inviteeId = req.params.inviteeId as string;
      
      const invitee = await inviteeService.getInviteeById(inviteeId, organizerId);
      
      res.status(200).json({ success: true, data: invitee });
    } catch (error: any) {
      if (error.message === 'INVITEE_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
      } else {
        next(error);
      }
    }
  },

  async updateInvitee(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const inviteeId = req.params.inviteeId as string;
      
      const invitee = await inviteeService.updateInvitee(inviteeId, organizerId, req.body);
      
      res.status(200).json({ success: true, data: invitee });
    } catch (error: any) {
      if (error.message === 'INVITEE_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
      } else if (error.message === 'DUPLICATE_INVITEE') {
        res.status(409).json({ error: 'Conflict', message: 'Invitee with this email or mobile already exists', details: [] });
      } else if (error.message === 'SET_LOCKED') {
        res.status(409).json({ success: false, code: 'SET_LOCKED', message: 'This guest belongs to an invitee list that invitations have already been sent from, so their details cannot be changed.' });
      } else {
        next(error);
      }
    }
  },

  async updateSessionAccess(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const inviteeId = req.params.inviteeId as string;
      
      const invitee = await inviteeService.updateSessionAccess(inviteeId, organizerId, req.body.sessionAccess);
      
      res.status(200).json({ success: true, data: invitee });
    } catch (error: any) {
      if (error.message === 'INVITEE_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
      } else if (error.message === 'INVALID_SESSIONS') {
        res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
      } else {
        next(error);
      }
    }
  },

  async bulkUpdateSessionAccess(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      
      const result = await inviteeService.bulkUpdateSessionAccess(eventId, organizerId, req.body.inviteeIds, req.body.sessionAccess);
      
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else if (error.message === 'INVALID_INVITEES') {
        res.status(400).json({ error: 'Bad Request', message: 'One or more invitees are invalid or belong to a different event', details: [] });
      } else if (error.message === 'INVALID_SESSIONS') {
        res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
      } else {
        next(error);
      }
    }
  },

  async deleteInvitee(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const inviteeId = req.params.inviteeId as string;
      
      const invitee = await inviteeService.deleteInvitee(inviteeId, organizerId);
      
      res.status(200).json({ success: true, data: { inviteeId: invitee._id, deleted: true } });
    } catch (error: any) {
      if (error.message === 'INVITEE_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
      } else if (error.message === 'SET_LOCKED') {
        res.status(409).json({ success: false, code: 'SET_LOCKED', message: 'This guest belongs to an invitee list that invitations have already been sent from, so they cannot be removed.' });
      } else if (error.message === 'HAS_HISTORY') {
        res.status(409).json({ success: false, code: 'HAS_HISTORY', message: 'This guest has been invited, has answered, or has attended, so they cannot be removed. Their history is kept.' });
      } else {
        next(error);
      }
    }
  },

  async importExcel(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      
      if (!req.file) {
        res.status(400).json({ error: 'Bad Request', message: 'No file uploaded', details: [] });
        return;
      }

      const rawSessionId = (req.body?.sessionId || req.query.sessionId || '') as string;
      if (rawSessionId && !/^[0-9a-fA-F]{24}$/.test(rawSessionId)) {
        res.status(400).json({ success: false, message: 'Invalid sessionId format' });
        return;
      }
      const rawMode = String(req.body?.mode || req.query.mode || 'REPLACE').toUpperCase();
      if (rawMode !== ImportMode.REPLACE && rawMode !== ImportMode.APPEND) {
        res.status(400).json({ success: false, message: 'mode must be REPLACE or APPEND' });
        return;
      }
      const result = await inviteeService.processExcelImport(eventId, organizerId, req.file.buffer, {
        mode: rawMode as ImportMode,
        fileName: req.file.originalname,
        dryRun: String(req.body?.dryRun ?? req.query.dryRun ?? '') === 'true',
        sessionId: rawSessionId || undefined,
        role: (req as any).user.role
      });
      
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else if (error?.code === 11000) {
        // The database's one-active-guest-per-email/phone rule refused a row (another change added the same person during
        // this import). The import has been rolled back as a whole.
        res.status(409).json({ success: false, code: 'IMPORT_CONFLICT', message: 'Another change added the same guest while this list was being imported, so nothing was imported. Please try again.' });
      } else {
        next(error);
      }
    }
  }
};
