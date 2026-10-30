"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventController = void 0;
const cancellationNotice_service_1 = require("../services/cancellationNotice.service");
const event_service_1 = require("../services/event.service");
const User_1 = require("../models/User");
exports.eventController = {
    async createEvent(req, res, next) {
        try {
            const authUser = req.user;
            const userRole = authUser.role;
            if (userRole === User_1.Role.ADMIN || userRole === 'SUPER_ADMIN') {
                const organizerIds = Array.isArray(req.body.organizerIds) && req.body.organizerIds.length > 0
                    ? req.body.organizerIds
                    : req.body.organizerId
                        ? [req.body.organizerId]
                        : null;
                if (organizerIds && organizerIds.length > 0) {
                    const eventsCreated = [];
                    for (const orgId of organizerIds) {
                        const event = await event_service_1.eventService.createEvent(orgId, { ...req.body, organizerId: orgId });
                        eventsCreated.push(event);
                    }
                    const primaryEvent = eventsCreated[0];
                    res.status(201).json({
                        success: true,
                        data: {
                            eventId: primaryEvent._id.toString(),
                            eventIds: eventsCreated.map((e) => e._id.toString()),
                            status: primaryEvent.status.toLowerCase(),
                            createdAt: primaryEvent.createdAt
                        }
                    });
                    return;
                }
            }
            const organizerId = authUser.userId;
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
            const event = await event_service_1.eventService.updateEvent(eventId, organizerId, req.body, req.user.role);
            res.status(200).json({ success: true, data: event });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'EVENT_CLOSED') {
                res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_CLOSED', message: 'A closed or cancelled event can no longer be edited.' });
            }
            else if (error.message === 'EVENT_LOCKED') {
                res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_LOCKED', message: 'This event can’t be edited after invitations have been sent.', details: [] });
            }
            else if (error.message === 'CATEGORY_NOT_FOUND' || error.message === 'TEMPLATE_NOT_FOUND') {
                res.status(400).json({ success: false, error: 'Bad Request', message: error.message === 'CATEGORY_NOT_FOUND' ? 'Selected category does not exist' : 'Selected template does not exist', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    /**
     * Cancels the event (terminal). `DELETE /events/:id` is kept for older clients and means exactly the same as
     * `POST /events/:id/cancel`: an event is never deleted by it.
     */
    async cancelEvent(req, res, next) {
        try {
            const { event, alreadyCancelled, notices } = await event_service_1.eventService.cancelEvent(req.params.eventId, { userId: req.user.userId, role: req.user.role }, typeof req.body?.reason === 'string' ? req.body.reason : undefined);
            res.status(200).json({
                success: true,
                data: { eventId: event._id, status: event.status, cancelledAt: event.cancelledAt, alreadyCancelled, notices }
            });
        }
        catch (error) {
            const message = error.message;
            if (message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (message === 'INVALID_TRANSITION') {
                res.status(409).json({ success: false, error: 'Conflict', code: 'INVALID_TRANSITION', message: 'A completed or closed event cannot be cancelled.' });
            }
            else if (message === 'FORBIDDEN') {
                res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized to cancel this event' });
            }
            else {
                next(error);
            }
        }
    },
    async getCancellationPreview(req, res, next) {
        try {
            const event = await event_service_1.eventService.findForNotices(req.params.eventId, req.user);
            res.status(200).json({ success: true, data: await cancellationNotice_service_1.cancellationNoticeService.preview(event._id) });
        }
        catch (error) {
            sendNoticeError(res, next, error);
        }
    },
    async getCancellationNotices(req, res, next) {
        try {
            const event = await event_service_1.eventService.findForNotices(req.params.eventId, req.user);
            res.status(200).json({ success: true, data: { cancelledAt: event.cancelledAt, reason: event.cancellationReason, ...(await cancellationNotice_service_1.cancellationNoticeService.summary(event._id)) } });
        }
        catch (error) {
            sendNoticeError(res, next, error);
        }
    },
    async retryCancellationNotices(req, res, next) {
        try {
            const event = await event_service_1.eventService.findForNotices(req.params.eventId, req.user);
            if (event.status !== 'CANCELLED')
                return res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_NOT_CANCELLED', message: 'Only a cancelled event has cancellation notices.' });
            // fill in anything missing (idempotent), then retry failed/unavailable channels; the response reports what was attempted
            await cancellationNotice_service_1.cancellationNoticeService.enqueueForEvent(event);
            const attempted = await cancellationNotice_service_1.cancellationNoticeService.processEvent(event._id, { retry: true });
            res.status(200).json({ success: true, data: { attempted, ...(await cancellationNotice_service_1.cancellationNoticeService.summary(event._id)) } });
        }
        catch (error) {
            sendNoticeError(res, next, error);
        }
    },
    async updateAdmission(req, res, next) {
        try {
            const event = await event_service_1.eventService.updateAdmission(req.params.eventId, { userId: req.user.userId, role: req.user.role }, req.body);
            res.status(200).json({ success: true, data: event });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'EVENT_CLOSED') {
                res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_CLOSED', message: 'The check-in window of a closed or cancelled event can no longer be changed.' });
            }
            else if (error.statusCode === 400) {
                res.status(400).json({ success: false, error: 'Bad Request', message: error.message });
            }
            else {
                next(error);
            }
        }
    },
    async closeEvent(req, res, next) {
        try {
            const event = await event_service_1.eventService.closeEvent(req.params.eventId, { userId: req.user.userId, role: req.user.role });
            res.status(200).json({ success: true, data: event });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'INVALID_TRANSITION') {
                res.status(409).json({ success: false, error: 'Conflict', code: 'INVALID_TRANSITION', message: 'Only a published event can be closed.' });
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
            const result = await event_service_1.eventService.cleanupEventOperationalData(eventId, actor, typeof req.body?.confirmTitle === 'string' ? req.body.confirmTitle : undefined);
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
            else if (error.message === 'EVENT_NOT_CLOSED') {
                res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_NOT_CLOSED', message: 'Close the event first. Permanent deletion is only available for closed events.' });
            }
            else if (error.message === 'CONFIRMATION_REQUIRED') {
                res.status(400).json({ success: false, error: 'Bad Request', code: 'CONFIRMATION_REQUIRED', message: 'Type the event title exactly to confirm permanent deletion.' });
            }
            else {
                next(error);
            }
        }
    }
};
function sendNoticeError(res, next, error) {
    if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
    }
    else if (error.message === 'FORBIDDEN') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized for this event' });
    }
    else {
        next(error);
    }
}
