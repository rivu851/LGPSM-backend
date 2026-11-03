"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionController = void 0;
const session_service_1 = require("../services/session.service");
const query_1 = require("../utils/query");
exports.sessionController = {
    async createSession(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const session = await session_service_1.sessionService.createSession(eventId, organizerId, req.body);
            res.status(201).json({
                success: true,
                data: session
            });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'SESSION_OUT_OF_BOUNDS') {
                res.status(400).json({ error: 'Bad Request', message: 'Session schedule is out of bounds of the event schedule', details: [] });
            }
            else if (error.message === 'INVALID_SOURCE_SESSION') {
                res.status(400).json({ error: 'Bad Request', message: 'Invalid source session', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async getSessions(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const { page, limit } = (0, query_1.pageParams)(req.query, { limit: 10, max: 200 });
            const result = await session_service_1.sessionService.getSessions(eventId, organizerId, { page, limit }, req.user.role);
            res.status(200).json({
                success: true,
                data: result.sessions,
                meta: {
                    page,
                    limit,
                    total: result.total
                }
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
    async getSessionById(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const sessionId = req.params.sessionId;
            const session = await session_service_1.sessionService.getSessionById(sessionId, organizerId);
            res.status(200).json({ success: true, data: session });
        }
        catch (error) {
            if (error.message === 'SESSION_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Session not found or inaccessible', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async updateSession(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const sessionId = req.params.sessionId;
            const session = await session_service_1.sessionService.updateSession(sessionId, organizerId, req.body);
            res.status(200).json({ success: true, data: session });
        }
        catch (error) {
            if (error.message === 'SESSION_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Session not found or inaccessible', details: [] });
            }
            else if (error.message === 'SESSION_OUT_OF_BOUNDS') {
                res.status(400).json({ error: 'Bad Request', message: 'Session schedule is out of bounds of the event schedule', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async deleteSession(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const sessionId = req.params.sessionId;
            const session = await session_service_1.sessionService.deleteSession(sessionId, organizerId);
            res.status(200).json({ success: true, data: { sessionId: session._id, deleted: true } });
        }
        catch (error) {
            if (error.message === 'SESSION_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Session not found or inaccessible', details: [] });
            }
            else {
                next(error);
            }
        }
    }
};
