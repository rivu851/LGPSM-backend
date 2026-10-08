import { Request, Response } from 'express';
import { reportService } from '../services/report.service';

const parseDate = (v: unknown) => {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
};

export const reportController = {
  async getEarnings(req: Request, res: Response) {
    try {
      const actor = (req as any).user;
      const data = await reportService.getEarnings({
        from: parseDate(req.query.from),
        to: parseDate(req.query.to),
        eventId: req.query.eventId as string | undefined,
        organizerId: actor.role === 'ORGANIZER' ? actor.userId : undefined,
      });
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  async getAdminOverview(req: Request, res: Response) {
    try {
      const data = await reportService.getAdminOverview({ from: parseDate(req.query.from), to: parseDate(req.query.to) });
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  async getDashboardStats(req: Request, res: Response) {
    try {
      const user = {
        userId: (req as any).user.userId,
        role: (req as any).user.role
      };
      const data = await reportService.getDashboardStats(user);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  },

  async getEventReport(req: Request, res: Response) {
    try {
      const eventId = req.params.eventId as string;
      const user = {
        userId: (req as any).user.userId,
        role: (req as any).user.role
      };
      const data = await reportService.getEventReport(eventId, user);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  }
};
