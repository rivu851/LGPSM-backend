"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserRole = getUserRole;
exports.findManageableEvent = findManageableEvent;
const Event_1 = require("../models/Event");
const User_1 = require("../models/User");
const SystemUserAssignment_1 = require("../models/SystemUserAssignment");
// Event lookup for management operations: admins can manage any event, organizers only their own.
// When the caller's role is not known it is read from the user record.
async function getUserRole(userId) {
    return (await User_1.User.findById(userId).select('role').lean())?.role;
}
async function findManageableEvent(eventId, actorId, role) {
    const effectiveRole = role ?? (await getUserRole(actorId));
    if (effectiveRole === User_1.Role.ADMIN) {
        return Event_1.Event.findById(eventId);
    }
    if (effectiveRole === User_1.Role.SYSTEM_USER) {
        // Staff (read-only callers) can access events they're assigned to for check-in duty
        const assignment = await SystemUserAssignment_1.SystemUserAssignment.findOne({ userId: actorId, eventId });
        return assignment ? Event_1.Event.findById(eventId) : null;
    }
    return Event_1.Event.findOne({ _id: eventId, organizerId: actorId });
}
