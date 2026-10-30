"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogController = void 0;
const auditLog_service_1 = require("../services/auditLog.service");
exports.auditLogController = {
    async getLogs(req, res) {
        try {
            const result = await auditLog_service_1.auditLogService.getLogs(req.user, {
                eventId: typeof req.query.eventId === 'string' ? req.query.eventId : undefined,
                actorId: typeof req.query.actorId === 'string' ? req.query.actorId : undefined,
                action: typeof req.query.action === 'string' ? req.query.action : undefined,
                page: parseInt(req.query.page) || 1,
                limit: parseInt(req.query.limit) || 20
            });
            return res.status(200).json({ success: true, data: result.logs, meta: { total: result.total, page: result.page, totalPages: result.totalPages } });
        }
        catch (error) {
            if (error?.message === 'INVALID_ID')
                return res.status(400).json({ success: false, error: 'Bad Request', message: 'Invalid identifier in filter' });
            if (error?.message === 'FORBIDDEN')
                return res.status(403).json({ success: false, error: 'Forbidden', message: 'Not permitted to view audit entries' });
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    }
};
