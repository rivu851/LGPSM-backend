"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeAssignedSession = exports.authorizeEventAccess = void 0;
const User_1 = require("../models/User");
const systemUserAssignment_repository_1 = require("../repositories/systemUserAssignment.repository");
const authorizeEventAccess = async (req, res, next) => {
    try {
        if (!req.user) {
            res.status(401).json({ success: false, message: 'Authentication required' });
            return;
        }
        const eventId = req.params.eventId || req.body.eventId;
        if (req.user.role === User_1.Role.ADMIN) {
            return next();
        }
        if (req.user.role === User_1.Role.ORGANIZER) {
            // In a more complete implementation, we might double check the event's organizerId matches req.user.userId here.
            // But for this phase, the controllers handle organizer ownership checks via the Service layer.
            return next();
        }
        if (req.user.role === User_1.Role.SYSTEM_USER) {
            if (!eventId) {
                res.status(400).json({ success: false, message: 'Event ID required for authorization' });
                return;
            }
            const assignment = await systemUserAssignment_repository_1.systemUserAssignmentRepository.findByUserAndEvent(req.user.userId, eventId);
            if (!assignment) {
                res.status(403).json({ success: false, message: 'Forbidden. No assignment for this event.' });
                return;
            }
            // Pass assignment down to request if needed
            req.assignment = assignment;
            return next();
        }
        res.status(403).json({ success: false, message: 'Forbidden' });
    }
    catch (error) {
        next(error);
    }
};
exports.authorizeEventAccess = authorizeEventAccess;
const authorizeAssignedSession = async (req, res, next) => {
    try {
        if (req.user?.role === User_1.Role.ADMIN || req.user?.role === User_1.Role.ORGANIZER) {
            return next();
        }
        if (req.user?.role === User_1.Role.SYSTEM_USER) {
            const assignment = req.assignment;
            if (!assignment) {
                res.status(403).json({ success: false, message: 'Forbidden. No assignment context found.' });
                return;
            }
            const sessionId = req.params.sessionId || req.body.sessionId;
            // An assignment with no sessions listed covers every session of the event (same rule as check-in)
            if (sessionId && assignment.sessionIds?.length > 0) {
                const hasAccess = assignment.sessionIds.some((id) => id.toString() === sessionId);
                if (!hasAccess) {
                    res.status(403).json({ success: false, message: 'Forbidden. Not assigned to this session.' });
                    return;
                }
            }
            return next();
        }
        res.status(403).json({ success: false, message: 'Forbidden' });
    }
    catch (error) {
        next(error);
    }
};
exports.authorizeAssignedSession = authorizeAssignedSession;
