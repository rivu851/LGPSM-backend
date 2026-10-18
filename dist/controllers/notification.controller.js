"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationController = void 0;
const notification_service_1 = require("../services/notification.service");
exports.notificationController = {
    async getUserNotifications(req, res) {
        try {
            const userId = req.user.userId;
            const unreadOnly = req.query.unreadOnly === 'true';
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const result = await notification_service_1.notificationService.getUserNotifications(userId, unreadOnly, page, limit);
            return res.status(200).json({ success: true, data: result.notifications, meta: { total: result.total, unreadCount: result.unreadCount, page: result.page, totalPages: result.totalPages } });
        }
        catch (error) {
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    },
    async markAsRead(req, res) {
        try {
            const userId = req.user.userId;
            const notification = await notification_service_1.notificationService.markAsRead(req.params.id, userId);
            return res.status(200).json({ success: true, data: notification });
        }
        catch (error) {
            if (error.message === 'NOTIFICATION_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Notification not found' });
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    },
    async markAllAsRead(req, res) {
        try {
            const userId = req.user.userId;
            await notification_service_1.notificationService.markAllAsRead(userId);
            return res.status(200).json({ success: true, message: 'All notifications marked as read' });
        }
        catch (error) {
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    },
    async createNotification(req, res) {
        try {
            const notification = await notification_service_1.notificationService.createNotification(req.body);
            return res.status(201).json({ success: true, data: notification });
        }
        catch (error) {
            return res.status(400).json({ error: 'Bad Request', message: error.message });
        }
    },
    async deleteNotification(req, res) {
        try {
            const userId = req.user.userId;
            await notification_service_1.notificationService.deleteNotification(req.params.id, userId);
            return res.status(200).json({ success: true, message: 'Notification cleared successfully' });
        }
        catch (error) {
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    },
    async clearAllNotifications(req, res) {
        try {
            const userId = req.user.userId;
            await notification_service_1.notificationService.clearAllNotifications(userId);
            return res.status(200).json({ success: true, message: 'All notifications cleared successfully' });
        }
        catch (error) {
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    }
};
