"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemUserAssignmentService = void 0;
const systemUserAssignment_repository_1 = require("../repositories/systemUserAssignment.repository");
const User_1 = require("../models/User");
const Session_1 = require("../models/Session");
const user_service_1 = require("./user.service");
const eventAccess_1 = require("../utils/eventAccess");
const event_repository_1 = require("../repositories/event.repository");
const mongoose_1 = __importDefault(require("mongoose"));
// Populate only selects a handful of Event fields (title/status/format/location/
// schedule/organizerId) — invitationsSent is computed on the fly, same as the
// events-list endpoint, so the mobile "Number of invites" figure isn't stuck
// showing nothing for every assignment.
async function withInvitationsSent(assignments) {
    const plain = assignments.map((a) => (typeof a.toObject === 'function' ? a.toObject() : a));
    const eventIds = plain
        .map((a) => a.eventId && typeof a.eventId === 'object' ? a.eventId._id : null)
        .filter((id) => !!id);
    const counts = await (0, event_repository_1.getInvitationCounts)(eventIds);
    plain.forEach((a) => {
        if (a.eventId && typeof a.eventId === 'object') {
            a.eventId.invitationsSent = counts.get(String(a.eventId._id)) || 0;
        }
    });
    return plain;
}
const findAccessibleEvent = (eventId, actorId) => (0, eventAccess_1.findManageableEvent)(eventId, actorId);
exports.systemUserAssignmentService = {
    async createAssignment(eventId, organizerId, data) {
        const event = await findAccessibleEvent(eventId, organizerId);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        const targetUser = await User_1.User.findById(data.userId);
        if (!targetUser || !targetUser.isActive || targetUser.role !== User_1.Role.SYSTEM_USER) {
            throw new Error('INVALID_USER');
        }
        // Organizers can only assign their own staff
        if ((await (0, eventAccess_1.getUserRole)(organizerId)) === User_1.Role.ORGANIZER) {
            const visible = await (0, user_service_1.staffVisibleToOrganizer)(organizerId);
            if (!visible.some((id) => String(id) === data.userId))
                throw new Error('INVALID_USER');
        }
        const existing = await systemUserAssignment_repository_1.systemUserAssignmentRepository.findByUserAndEvent(data.userId, eventId);
        if (existing) {
            throw new Error('DUPLICATE_ASSIGNMENT');
        }
        // Verify sessions belong to event
        const uniqueSessionIds = [...new Set(data.sessionIds)];
        if (uniqueSessionIds.length > 0) {
            const sessions = await Session_1.Session.find({ _id: { $in: uniqueSessionIds }, eventId });
            if (sessions.length !== uniqueSessionIds.length) {
                throw new Error('INVALID_SESSIONS');
            }
        }
        const assignmentData = {
            userId: new mongoose_1.default.Types.ObjectId(data.userId),
            eventId: new mongoose_1.default.Types.ObjectId(eventId),
            sessionIds: uniqueSessionIds.map(id => new mongoose_1.default.Types.ObjectId(id)),
            assignedBy: new mongoose_1.default.Types.ObjectId(organizerId)
        };
        return await systemUserAssignment_repository_1.systemUserAssignmentRepository.create(assignmentData);
    },
    async getAssignmentsByEvent(eventId, organizerId) {
        const event = await findAccessibleEvent(eventId, organizerId);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        return await systemUserAssignment_repository_1.systemUserAssignmentRepository.findByEventId(eventId);
    },
    async getAssignmentsByUser(userId, actor) {
        const assignments = await systemUserAssignment_repository_1.systemUserAssignmentRepository.findByUserId(userId);
        const withCounts = await withInvitationsSent(assignments);
        if (actor.role === User_1.Role.ORGANIZER) {
            // Organizers only see this staff member's assignments on their own events
            return withCounts.filter((a) => {
                const event = a.eventId;
                const eventOrganizerId = event && typeof event === 'object' ? event.organizerId : null;
                return eventOrganizerId && String(eventOrganizerId) === actor.userId;
            });
        }
        return withCounts;
    },
    async updateAssignment(assignmentId, organizerId, sessionIds) {
        const assignment = await systemUserAssignment_repository_1.systemUserAssignmentRepository.findById(assignmentId);
        if (!assignment) {
            throw new Error('ASSIGNMENT_NOT_FOUND');
        }
        const event = await findAccessibleEvent(assignment.eventId.toString(), organizerId);
        if (!event) {
            throw new Error('ASSIGNMENT_NOT_FOUND');
        }
        const uniqueSessionIds = [...new Set(sessionIds)];
        if (uniqueSessionIds.length > 0) {
            const sessions = await Session_1.Session.find({ _id: { $in: uniqueSessionIds }, eventId: assignment.eventId });
            if (sessions.length !== uniqueSessionIds.length) {
                throw new Error('INVALID_SESSIONS');
            }
        }
        const updated = await systemUserAssignment_repository_1.systemUserAssignmentRepository.update(assignmentId, {
            sessionIds: uniqueSessionIds.map(id => new mongoose_1.default.Types.ObjectId(id))
        });
        if (!updated) {
            throw new Error('UPDATE_FAILED');
        }
        return updated;
    },
    async deleteAssignment(assignmentId, organizerId) {
        const assignment = await systemUserAssignment_repository_1.systemUserAssignmentRepository.findById(assignmentId);
        if (!assignment) {
            throw new Error('ASSIGNMENT_NOT_FOUND');
        }
        const event = await findAccessibleEvent(assignment.eventId.toString(), organizerId);
        if (!event) {
            throw new Error('ASSIGNMENT_NOT_FOUND');
        }
        const deleted = await systemUserAssignment_repository_1.systemUserAssignmentRepository.delete(assignmentId);
        if (!deleted) {
            throw new Error('DELETE_FAILED');
        }
        return deleted;
    }
};
