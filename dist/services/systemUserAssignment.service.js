"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemUserAssignmentService = void 0;
exports.activeAssignmentsOf = activeAssignmentsOf;
const systemUserAssignment_repository_1 = require("../repositories/systemUserAssignment.repository");
const SystemUserAssignment_1 = require("../models/SystemUserAssignment");
const Event_1 = require("../models/Event");
const User_1 = require("../models/User");
const Session_1 = require("../models/Session");
const user_service_1 = require("./user.service");
const eventAccess_1 = require("../utils/eventAccess");
const event_repository_1 = require("../repositories/event.repository");
const mongoose_1 = __importDefault(require("mongoose"));
const eventLifecycle_1 = require("../utils/eventLifecycle");
const alert_service_1 = require("./alert.service");
/** The assignments of an event whose person is still active: a deactivated or deleted staff account is not "assigned" any more in any count */
async function activeAssignmentsOf(eventId, select = 'userId sessionIds') {
    const rows = await SystemUserAssignment_1.SystemUserAssignment.find({ eventId }, select).lean();
    if (rows.length === 0)
        return rows;
    const active = new Set((await User_1.User.find({ _id: { $in: rows.map((r) => r.userId) }, isActive: { $ne: false } }).select('_id').lean()).map((u) => String(u._id)));
    return rows.filter((r) => active.has(String(r.userId)));
}
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
        // Staff are not assigned to an event that no longer takes place: it would look like live work on their phone
        if (event.status === 'CANCELLED') {
            throw new Error('EVENT_CANCELLED');
        }
        (0, eventLifecycle_1.assertEventOpenForChanges)(event);
        const targetUser = await User_1.User.findById(data.userId);
        if (!targetUser || !targetUser.isActive) {
            throw new Error('INVALID_USER');
        }
        // Only a system user, the event's own organizer, or the person making the assignment (an organizer or administrator working the event
        // themselves) can be assigned: never some other organizer or administrator
        if (targetUser.role !== User_1.Role.SYSTEM_USER && String(targetUser._id) !== String(event.organizerId) && String(targetUser._id) !== organizerId) {
            throw new Error('INVALID_USER');
        }
        // Organizers can assign themselves or staff visible to their organization.
        if ((await (0, eventAccess_1.getUserRole)(organizerId)) === User_1.Role.ORGANIZER && data.userId !== organizerId) {
            const visible = await (0, user_service_1.staffVisibleToOrganizer)(organizerId);
            if (!visible.some((id) => String(id) === data.userId))
                throw new Error('INVALID_USER');
        }
        // Switched off for now: a small event may be run entirely by its organizer, who then also works it as a system user (an organizer
        // and a system user may share an email). To bring back "the organizer of an event is not also its staff", restore this check
        // (matched by email, so it covers their organizer account and their system user account) and the IS_EVENT_ORGANIZER branch in
        // systemUserAssignment.controller.ts:
        //
        // const owner: any = await User.findById((event as any).organizerId);
        // const sameEmail = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
        // if (sameEmail(owner?.email, targetUser.email)) throw new Error('IS_EVENT_ORGANIZER');
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
        const created = await systemUserAssignment_repository_1.systemUserAssignmentRepository.create(assignmentData);
        await this.tellStaff(event, data.userId, uniqueSessionIds, 'ASSIGNED');
        return created;
    },
    async getAssignmentsByEvent(eventId, organizerId) {
        const event = await findAccessibleEvent(eventId, organizerId);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        return await systemUserAssignment_repository_1.systemUserAssignmentRepository.findByEventId(eventId);
    },
    /**
     * Staff of this event's organizer who are already assigned to another of that organizer's events running at the same time
     * (the two time ranges overlap). Used to warn before the same person is put on two events at once; nothing is blocked.
     *
     * With `includeAll` it returns every assignment those staff hold on the organizer's OTHER (non-cancelled) events, each marked
     * with whether it overlaps this event in time, so a screen can show a person's real workload and the clash warning from one
     * dataset. `sessionIds` empty means all sessions of that event.
     */
    async overlapsForEvent(eventId, actorId, includeAll = false) {
        const event = await findAccessibleEvent(eventId, actorId);
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        const start = event.schedule?.start, end = event.schedule?.end;
        if (!includeAll && (!start || !end))
            return [];
        const query = { organizerId: event.organizerId, _id: { $ne: event._id }, status: { $ne: 'CANCELLED' } };
        if (!includeAll) {
            query['schedule.start'] = { $lt: end };
            query['schedule.end'] = { $gt: start };
        }
        const others = await Event_1.Event.find(query).select('title schedule').lean();
        if (!others.length)
            return [];
        const byId = new Map(others.map((e) => [String(e._id), e]));
        const assignments = await SystemUserAssignment_1.SystemUserAssignment.find({ eventId: { $in: others.map((e) => e._id) } }).select('userId eventId sessionIds').lean();
        return assignments.map((a) => {
            const e = byId.get(String(a.eventId));
            const overlaps = !!start && !!end && !!e.schedule?.start && !!e.schedule?.end && e.schedule.start < end && e.schedule.end > start;
            return {
                userId: String(a.userId), eventId: String(e._id), title: e.title, start: e.schedule?.start, end: e.schedule?.end,
                sessionIds: (a.sessionIds || []).map((id) => String(id)), overlaps
            };
        });
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
        (0, eventLifecycle_1.assertEventOpenForChanges)(event);
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
        await this.tellStaff(event, String(assignment.userId), uniqueSessionIds, 'CHANGED');
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
        (0, eventLifecycle_1.assertEventOpenForChanges)(event);
        const deleted = await systemUserAssignment_repository_1.systemUserAssignmentRepository.delete(assignmentId);
        if (!deleted) {
            throw new Error('DELETE_FAILED');
        }
        await this.tellStaff(event, String(assignment.userId), [], 'REMOVED');
        return deleted;
    },
    /** The staff member is told in the app when they are put on an event, when their sessions change, or when they are taken off it */
    async tellStaff(event, userId, sessionIds, what) {
        // a notice never fails the assignment it is about
        try {
            // (an organizer working their own event does not need telling about their own action)
            const target = await User_1.User.findById(userId);
            if (!target || target.role !== User_1.Role.SYSTEM_USER)
                return;
            let where = 'all its sessions';
            if (sessionIds.length > 0) {
                const names = (await Session_1.Session.find({ _id: { $in: sessionIds } })).map((s) => s.name);
                where = names.length ? names.join(', ') : `${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'}`;
            }
            const title = event.title || 'an event';
            const copy = {
                ASSIGNED: { title: 'You were assigned to an event', message: `You are now assigned to "${title}" (${where}).` },
                CHANGED: { title: 'Your assignment changed', message: `Your assignment on "${title}" now covers ${where}.` },
                REMOVED: { title: 'You were removed from an event', message: `You are no longer assigned to "${title}".` }
            }[what];
            // (not awaited: the assignment does not wait for the notice to be stored)
            void alert_service_1.alertService.notifyUser(userId, { type: `STAFF_${what}`, entityType: 'Event', entityId: event._id, ...copy }).catch(() => undefined);
        }
        catch (err) {
            console.error('Staff notice failed:', err.message);
        }
    }
};
