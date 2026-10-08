"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportController = void 0;
const report_service_1 = require("../services/report.service");
const parseDate = (v) => {
    if (typeof v !== 'string' || !v)
        return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
};
exports.reportController = {
    async getEarnings(req, res) {
        try {
            const actor = req.user;
            const data = await report_service_1.reportService.getEarnings({
                from: parseDate(req.query.from),
                to: parseDate(req.query.to),
                eventId: req.query.eventId,
                organizerId: actor.role === 'ORGANIZER' ? actor.userId : undefined,
            });
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    },
    async getAdminOverview(req, res) {
        try {
            const data = await report_service_1.reportService.getAdminOverview({ from: parseDate(req.query.from), to: parseDate(req.query.to) });
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    },
    async getDashboardStats(req, res) {
        try {
            const user = {
                userId: req.user.userId,
                role: req.user.role
            };
            const data = await report_service_1.reportService.getDashboardStats(user);
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    },
    async getEventReport(req, res) {
        try {
            const eventId = req.params.eventId;
            const user = {
                userId: req.user.userId,
                role: req.user.role
            };
            const data = await report_service_1.reportService.getEventReport(eventId, user);
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    }
};
