import { Request, Response } from 'express';
import { notificationService } from '../services/notification.service';

export const notificationController = {
  async getUserNotifications(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      const unreadOnly = req.query.unreadOnly === 'true';
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      const result = await notificationService.getUserNotifications(userId, unreadOnly, page, limit);
      return res.status(200).json({ success: true, data: result.notifications, meta: { total: result.total, unreadCount: result.unreadCount, page: result.page, totalPages: result.totalPages } });
    } catch (error: any) {
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async markAsRead(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      const notification = await notificationService.markAsRead(req.params.id as string, userId);
      return res.status(200).json({ success: true, data: notification });
    } catch (error: any) {
      if (error.message === 'NOTIFICATION_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Notification not found' });
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async markAllAsRead(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      await notificationService.markAllAsRead(userId);
      return res.status(200).json({ success: true, message: 'All notifications marked as read' });
    } catch (error: any) {
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async createNotification(req: Request, res: Response) {
    try {
      const notification = await notificationService.createNotification(req.body);
      return res.status(201).json({ success: true, data: notification });
    } catch (error: any) {
      return res.status(400).json({ error: 'Bad Request', message: error.message });
    }
  },

  async deleteNotification(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      await notificationService.deleteNotification(req.params.id as string, userId);
      return res.status(200).json({ success: true, message: 'Notification cleared successfully' });
    } catch (error: any) {
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async clearAllNotifications(req: Request, res: Response) {
    try {
      const userId = (req as any).user.userId;
      await notificationService.clearAllNotifications(userId);
      return res.status(200).json({ success: true, message: 'All notifications cleared successfully' });
    } catch (error: any) {
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  }
};
