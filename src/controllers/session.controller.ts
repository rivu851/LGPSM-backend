import { Request, Response, NextFunction } from 'express';
import { sessionService } from '../services/session.service';
import { pageParams } from '../utils/query';

export const sessionController = {
  async createSession(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      
      const session = await sessionService.createSession(eventId, organizerId, req.body);
      
      res.status(201).json({
        success: true,
        data: session
      });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else if (error.message === 'SESSION_OUT_OF_BOUNDS') {
        res.status(400).json({ error: 'Bad Request', message: 'Session schedule is out of bounds of the event schedule', details: [] });
      } else if (error.message === 'INVALID_SOURCE_SESSION') {
        res.status(400).json({ error: 'Bad Request', message: 'Invalid source session', details: [] });
      } else {
        next(error);
      }
    }
  },

  async getSessions(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      const { page, limit } = pageParams(req.query, { limit: 10, max: 200 });

      const result = await sessionService.getSessions(eventId, organizerId, { page, limit }, (req as any).user.role);
      
      res.status(200).json({
        success: true,
        data: result.sessions,
        meta: {
          page,
          limit,
          total: result.total
        }
      });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else {
        next(error);
      }
    }
  },

  async getSessionById(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const sessionId = req.params.sessionId as string;
      
      const session = await sessionService.getSessionById(sessionId, organizerId);
      
      res.status(200).json({ success: true, data: session });
    } catch (error: any) {
      if (error.message === 'SESSION_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Session not found or inaccessible', details: [] });
      } else {
        next(error);
      }
    }
  },

  async updateSession(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const sessionId = req.params.sessionId as string;
      
      const session = await sessionService.updateSession(sessionId, organizerId, req.body);
      
      res.status(200).json({ success: true, data: session });
    } catch (error: any) {
       if (error.message === 'SESSION_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Session not found or inaccessible', details: [] });
      } else if (error.message === 'SESSION_OUT_OF_BOUNDS') {
        res.status(400).json({ error: 'Bad Request', message: 'Session schedule is out of bounds of the event schedule', details: [] });
      } else {
        next(error);
      }
    }
  },

  async deleteSession(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const sessionId = req.params.sessionId as string;
      
      const session = await sessionService.deleteSession(sessionId, organizerId);
      
      res.status(200).json({ success: true, data: { sessionId: session._id, deleted: true } });
    } catch (error: any) {
       if (error.message === 'SESSION_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Session not found or inaccessible', details: [] });
      } else {
        next(error);
      }
    }
  }
};
