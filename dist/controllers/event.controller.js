"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventController = void 0;
const event_service_1 = require("../services/event.service");
exports.eventController = {
    async createEvent(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const event = await event_service_1.eventService.createEvent(organizerId, req.body);
            res.status(201).json({
                success: true,
                data: {
                    eventId: event._id.toString(),
                    status: event.status.toLowerCase(),
                    createdAt: event.createdAt
                }
            });
        }
        catch (error) {
            next(error);
        }
    },
    async getEvents(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const requestedOrganizer = req.query.organizerId;
            if (requestedOrganizer && !/^[0-9a-fA-F]{24}$/.test(requestedOrganizer)) {
                res.status(400).json({ success: false, message: 'Invalid organizerId format' });
                return;
            }
            const filter = {
                status: req.query.status,
                categoryId: req.query.categoryId,
                organizerId: requestedOrganizer
            };
            const result = await event_service_1.eventService.getEventsByOrganizer(organizerId, filter, { page, limit }, req.user.role);
            res.status(200).json({
                success: true,
                data: result.events,
                meta: {
                    page,
                    limit,
                    total: result.total
                }
            });
        }
        catch (error) {
            next(error);
        }
    },
    async getEventById(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const event = await event_service_1.eventService.getEventDetails(eventId, organizerId, req.user.role);
            res.status(200).json({ success: true, data: event });
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
    async updateEvent(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const event = await event_service_1.eventService.updateEvent(eventId, organizerId, req.body);
            res.status(200).json({ success: true, data: event });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'CATEGORY_NOT_FOUND' || error.message === 'TEMPLATE_NOT_FOUND') {
                res.status(400).json({ success: false, error: 'Bad Request', message: error.message === 'CATEGORY_NOT_FOUND' ? 'Selected category does not exist' : 'Selected template does not exist', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async deleteEvent(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const event = await event_service_1.eventService.deactivateEvent(eventId, organizerId);
            res.status(200).json({ success: true, data: { eventId: event._id, status: event.status } });
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
    async cleanupEventData(req, res, next) {
        try {
            const actor = {
                userId: req.user.userId,
                role: req.user.role
            };
            const eventId = req.params.eventId;
            const result = await event_service_1.eventService.cleanupEventOperationalData(eventId, actor);
            res.status(200).json({
                success: true,
                message: result.alreadyCleared
                    ? 'Operational data has already been cleared for this event'
                    : 'Event operational data successfully cleared',
                data: result.event,
                cleanedCounts: result.cleanedCounts
            });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ success: false, error: 'Not Found', message: 'Event not found' });
            }
            else if (error.message === 'FORBIDDEN_CLEANUP') {
                res.status(403).json({ success: false, error: 'Forbidden', message: 'Only authorized ADMIN can perform event operational data cleanup' });
            }
            else if (error.message === 'EVENT_NOT_ENDED') {
                res.status(400).json({ success: false, error: 'Bad Request', message: 'Cannot clean operational data for an active or unended event' });
            }
            else {
                next(error);
            }
        }
    }
};
