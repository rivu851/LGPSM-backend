"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogController = void 0;
const auditLog_service_1 = require("../services/auditLog.service");
exports.auditLogController = {
    async getLogs(req, res) {
        try {
            const filters = {
                eventId: req.query.eventId,
                // Organizers may only review their own activity; admins can filter freely
                actorId: req.user?.role === 'ORGANIZER' ? req.user.userId : req.query.actorId,
                action: req.query.action,
                page: parseInt(req.query.page) || 1,
                limit: parseInt(req.query.limit) || 20
            };
            const result = await auditLog_service_1.auditLogService.getLogs(filters);
            return res.status(200).json({ success: true, data: result.logs, meta: { total: result.total, page: result.page, totalPages: result.totalPages } });
        }
        catch (error) {
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    }
};
