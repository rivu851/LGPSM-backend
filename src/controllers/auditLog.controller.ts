import { Request, Response } from 'express';
import { auditLogService } from '../services/auditLog.service';

export const auditLogController = {
  async getLogs(req: Request, res: Response) {
    try {
      const filters = {
        eventId: req.query.eventId as string,
        // Organizers may only review their own activity; admins can filter freely
        actorId: (req as any).user?.role === 'ORGANIZER' ? (req as any).user.userId : req.query.actorId as string,
        action: req.query.action as string,
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 20
      };

      const result = await auditLogService.getLogs(filters);
      return res.status(200).json({ success: true, data: result.logs, meta: { total: result.total, page: result.page, totalPages: result.totalPages } });
    } catch (error: any) {
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  }
};
