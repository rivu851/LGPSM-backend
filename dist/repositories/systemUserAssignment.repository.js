"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemUserAssignmentRepository = void 0;
const SystemUserAssignment_1 = require("../models/SystemUserAssignment");
exports.systemUserAssignmentRepository = {
    async create(data) {
        const assignment = new SystemUserAssignment_1.SystemUserAssignment(data);
        const saved = await assignment.save();
        return (await SystemUserAssignment_1.SystemUserAssignment.findById(saved._id)
            .populate('userId', 'fullName email phone role')
            .populate('sessionIds', 'name schedule')
            .populate('assignedBy', 'fullName email')
            .populate('eventId', 'title status schedule'));
    },
    async findByEventId(eventId) {
        return await SystemUserAssignment_1.SystemUserAssignment.find({ eventId })
            .populate('userId', 'fullName email phone role')
            .populate('sessionIds', 'name schedule')
            .populate('assignedBy', 'fullName email')
            .populate('eventId', 'title status schedule');
    },
    async findByUserId(userId) {
        return await SystemUserAssignment_1.SystemUserAssignment.find({ userId })
            .populate('eventId', 'title status format location schedule organizerId')
            .populate('sessionIds', 'name schedule')
            .populate('assignedBy', 'fullName email');
    },
    async findById(assignmentId) {
        return await SystemUserAssignment_1.SystemUserAssignment.findById(assignmentId);
    },
    async findByUserAndEvent(userId, eventId) {
        return await SystemUserAssignment_1.SystemUserAssignment.findOne({ userId, eventId });
    },
    async update(assignmentId, data) {
        return await SystemUserAssignment_1.SystemUserAssignment.findByIdAndUpdate(assignmentId, data, { new: true, runValidators: true })
            .populate('userId', 'fullName email phone role')
            .populate('sessionIds', 'name schedule')
            .populate('assignedBy', 'fullName email')
            .populate('eventId', 'title status schedule');
    },
    async delete(assignmentId) {
        return await SystemUserAssignment_1.SystemUserAssignment.findByIdAndDelete(assignmentId);
    }
};
