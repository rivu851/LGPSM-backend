"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogRepository = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const AuditLog_1 = require("../models/AuditLog");
exports.auditLogRepository = {
    async create(data) {
        return await AuditLog_1.AuditLog.create(data);
    },
    async finish(id, patch) {
        const set = { status: patch.status };
        if (patch.eventId)
            set.eventId = patch.eventId;
        if (patch.organizerId)
            set.organizerId = patch.organizerId;
        if (patch.entityId)
            set.entityId = patch.entityId;
        if (patch.metadata)
            set.metadata = patch.metadata;
        await AuditLog_1.AuditLog.updateOne({ _id: id }, { $set: set });
    },
    async findLogs(filters) {
        const query = {};
        if (filters.eventId)
            query.eventId = new mongoose_1.default.Types.ObjectId(filters.eventId);
        if (filters.actorId)
            query.actorId = new mongoose_1.default.Types.ObjectId(filters.actorId);
        if (filters.organizerId)
            query.organizerId = new mongoose_1.default.Types.ObjectId(filters.organizerId);
        if (filters.action)
            query.action = String(filters.action);
        const limit = Math.min(Math.max(filters.limit || 20, 1), 100);
        const page = Math.max(filters.page || 1, 1);
        const skip = (page - 1) * limit;
        const logs = await AuditLog_1.AuditLog.find(query)
            .populate('actorId', 'fullName email role')
            .populate('eventId', 'title')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);
        const total = await AuditLog_1.AuditLog.countDocuments(query);
        return { logs, total, page, totalPages: Math.ceil(total / limit) };
    }
};
