import { Request, Response, NextFunction } from 'express';
import { inviteeService } from '../services/invitee.service';

export const inviteeController = {
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
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      
      const options = {
        page,
        limit,
        rsvpStatus: req.query.rsvpStatus as string,
        invitationStatus: req.query.invitationStatus as string,
        search: req.query.search as string
      };

      const result = await inviteeService.getInvitees(eventId, organizerId, options, (req as any).user.role);
      
      res.status(200).json({
        success: true,
        data: result.invitees,
        meta: { page, limit, total: result.total }
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
      const result = await inviteeService.processExcelImport(eventId, organizerId, req.file.buffer, {
        sessionId: rawSessionId || undefined,
        role: (req as any).user.role
      });
      
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else {
        next(error);
      }
    }
  }
};
