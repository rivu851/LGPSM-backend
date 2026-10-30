import { Request, Response } from 'express';
import { auditLogService } from '../services/auditLog.service';

export const auditLogController = {
  async getLogs(req: Request, res: Response) {
    try {
      const result = await auditLogService.getLogs((req as any).user, {
        eventId: typeof req.query.eventId === 'string' ? req.query.eventId : undefined,
        actorId: typeof req.query.actorId === 'string' ? req.query.actorId : undefined,
        action: typeof req.query.action === 'string' ? req.query.action : undefined,
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 20
      });
      return res.status(200).json({ success: true, data: result.logs, meta: { total: result.total, page: result.page, totalPages: result.totalPages } });
    } catch (error: any) {
      if (error?.message === 'INVALID_ID') return res.status(400).json({ success: false, error: 'Bad Request', message: 'Invalid identifier in filter' });
      if (error?.message === 'FORBIDDEN') return res.status(403).json({ success: false, error: 'Forbidden', message: 'Not permitted to view audit entries' });
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  }
};
