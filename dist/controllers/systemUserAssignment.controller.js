"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemUserAssignmentController = void 0;
const systemUserAssignment_service_1 = require("../services/systemUserAssignment.service");
exports.systemUserAssignmentController = {
    async createAssignment(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const assignment = await systemUserAssignment_service_1.systemUserAssignmentService.createAssignment(eventId, organizerId, req.body);
            res.status(201).json({ success: true, data: assignment });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'INVALID_USER') {
                res.status(400).json({ error: 'Bad Request', message: 'Invalid or inactive system user', details: [] });
            }
            else if (error.message === 'DUPLICATE_ASSIGNMENT') {
                res.status(409).json({ error: 'Conflict', message: 'User is already assigned to this event', details: [] });
            }
            else if (error.message === 'INVALID_SESSIONS') {
                res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async getAssignmentsByEvent(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const assignments = await systemUserAssignment_service_1.systemUserAssignmentService.getAssignmentsByEvent(eventId, organizerId);
            res.status(200).json({ success: true, data: assignments });
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
    async getMyAssignments(req, res, next) {
        try {
            const userId = req.user.userId;
            const assignments = await systemUserAssignment_service_1.systemUserAssignmentService.getAssignmentsByUser(userId, req.user);
            res.status(200).json({ success: true, data: assignments });
        }
        catch (error) {
            next(error);
        }
    },
    async updateAssignment(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const assignmentId = req.params.assignmentId;
            const assignment = await systemUserAssignment_service_1.systemUserAssignmentService.updateAssignment(assignmentId, organizerId, req.body.sessionIds);
            res.status(200).json({ success: true, data: assignment });
        }
        catch (error) {
            if (error.message === 'ASSIGNMENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Assignment not found or inaccessible', details: [] });
            }
            else if (error.message === 'INVALID_SESSIONS') {
                res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async deleteAssignment(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const assignmentId = req.params.assignmentId;
            const assignment = await systemUserAssignment_service_1.systemUserAssignmentService.deleteAssignment(assignmentId, organizerId);
            res.status(200).json({ success: true, data: { assignmentId: assignment._id, deleted: true } });
        }
        catch (error) {
            if (error.message === 'ASSIGNMENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Assignment not found or inaccessible', details: [] });
            }
            else {
                next(error);
            }
        }
    }
};
