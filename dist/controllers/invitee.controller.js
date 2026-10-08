"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteeController = void 0;
const invitee_service_1 = require("../services/invitee.service");
exports.inviteeController = {
    async createInvitee(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const invitee = await invitee_service_1.inviteeService.createInvitee(eventId, organizerId, req.body, req.user.role);
            res.status(201).json({ success: true, data: invitee });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'DUPLICATE_INVITEE') {
                res.status(409).json({ error: 'Conflict', message: 'Invitee already exists', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async getInvitees(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const options = {
                page,
                limit,
                rsvpStatus: req.query.rsvpStatus,
                invitationStatus: req.query.invitationStatus,
                search: req.query.search
            };
            const result = await invitee_service_1.inviteeService.getInvitees(eventId, organizerId, options, req.user.role);
            res.status(200).json({
                success: true,
                data: result.invitees,
                meta: { page, limit, total: result.total }
            });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async getInviteeById(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const inviteeId = req.params.inviteeId;
            const invitee = await invitee_service_1.inviteeService.getInviteeById(inviteeId, organizerId);
            res.status(200).json({ success: true, data: invitee });
        }
        catch (error) {
            if (error.message === 'INVITEE_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async updateInvitee(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const inviteeId = req.params.inviteeId;
            const invitee = await invitee_service_1.inviteeService.updateInvitee(inviteeId, organizerId, req.body);
            res.status(200).json({ success: true, data: invitee });
        }
        catch (error) {
            if (error.message === 'INVITEE_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
            }
            else if (error.message === 'DUPLICATE_INVITEE') {
                res.status(409).json({ error: 'Conflict', message: 'Invitee with this email or mobile already exists', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async updateSessionAccess(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const inviteeId = req.params.inviteeId;
            const invitee = await invitee_service_1.inviteeService.updateSessionAccess(inviteeId, organizerId, req.body.sessionAccess);
            res.status(200).json({ success: true, data: invitee });
        }
        catch (error) {
            if (error.message === 'INVITEE_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
            }
            else if (error.message === 'INVALID_SESSIONS') {
                res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async bulkUpdateSessionAccess(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const result = await invitee_service_1.inviteeService.bulkUpdateSessionAccess(eventId, organizerId, req.body.inviteeIds, req.body.sessionAccess);
            res.status(200).json({ success: true, data: result });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'INVALID_INVITEES') {
                res.status(400).json({ error: 'Bad Request', message: 'One or more invitees are invalid or belong to a different event', details: [] });
            }
            else if (error.message === 'INVALID_SESSIONS') {
                res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async deleteInvitee(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const inviteeId = req.params.inviteeId;
            const invitee = await invitee_service_1.inviteeService.deleteInvitee(inviteeId, organizerId);
            res.status(200).json({ success: true, data: { inviteeId: invitee._id, deleted: true } });
        }
        catch (error) {
            if (error.message === 'INVITEE_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async importExcel(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            if (!req.file) {
                res.status(400).json({ error: 'Bad Request', message: 'No file uploaded', details: [] });
                return;
            }
            const rawSessionId = (req.body?.sessionId || req.query.sessionId || '');
            if (rawSessionId && !/^[0-9a-fA-F]{24}$/.test(rawSessionId)) {
                res.status(400).json({ success: false, message: 'Invalid sessionId format' });
                return;
            }
            const result = await invitee_service_1.inviteeService.processExcelImport(eventId, organizerId, req.file.buffer, {
                sessionId: rawSessionId || undefined,
                role: req.user.role
            });
            res.status(200).json({ success: true, data: result });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else {
                next(error);
            }
        }
    }
};
