"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogService = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const auditLog_repository_1 = require("../repositories/auditLog.repository");
const Event_1 = require("../models/Event");
const User_1 = require("../models/User");
const auditSanitize_1 = require("../utils/auditSanitize");
const ROLES = new Set([User_1.Role.ADMIN, User_1.Role.ORGANIZER, User_1.Role.SYSTEM_USER]);
const asId = (v) => (v && mongoose_1.default.Types.ObjectId.isValid(String(v)) ? new mongoose_1.default.Types.ObjectId(String(v)) : undefined);
function toDoc(entry) {
    const actorId = asId(entry.actorId);
    const role = String(entry.actorRole || '');
    // An entry without a real actor is not evidence of anything; refuse to write it
    if (!actorId || !ROLES.has(role) || !entry.action)
        return null;
    return {
        actorId,
        actorType: role,
        eventId: asId(entry.eventId),
        organizerId: asId(entry.organizerId),
        action: entry.action,
        entityType: entry.entityType,
        entityId: asId(entry.entityId),
        status: entry.status || 'SUCCESS',
        description: entry.description?.slice(0, 300),
        requestId: entry.requestId,
        metadata: (0, auditSanitize_1.sanitizeAuditMetadata)(entry.metadata)
    };
}
exports.auditLogService = {
    /** Strict write: throws if the entry is invalid or cannot be stored. Used where the caller must fail closed. */
    async logAction(entry) {
        const doc = toDoc(entry);
        if (!doc)
            throw new Error('AUDIT_INVALID_ACTOR');
        return auditLog_repository_1.auditLogRepository.create(doc);
    },
    /** Best-effort write for non-critical actions: a failure is reported on the server log but never breaks the request. */
    async record(entry) {
        try {
            return await this.logAction(entry);
        }
        catch (error) {
            console.error('Audit write failed:', entry.action, error?.message);
            return null;
        }
    },
    /** The tenant that owns an event, so entries can be isolated per organizer. */
    async organizerOfEvent(eventId) {
        const id = asId(eventId);
        if (!id)
            return undefined;
        const ev = await Event_1.Event.findById(id).select('organizerId').lean();
        return ev?.organizerId;
    },
    async finish(id, patch) {
        try {
            await auditLog_repository_1.auditLogRepository.finish(String(id), {
                status: patch.status,
                eventId: asId(patch.eventId),
                organizerId: asId(patch.organizerId),
                entityId: asId(patch.entityId),
                metadata: patch.metadata ? (0, auditSanitize_1.sanitizeAuditMetadata)(patch.metadata) : undefined
            });
        }
        catch (error) {
            // The PENDING entry still proves the attempt happened
            console.error('Audit completion failed:', error?.message);
        }
    },
    /**
     * Role-scoped read. Isolation is decided here on the server and cannot be widened by query parameters:
     * an organizer is always pinned to their own tenant; an admin sees the platform.
     */
    async getLogs(actor, query) {
        const filters = { action: query.action, page: query.page, limit: query.limit };
        if (query.eventId) {
            if (!asId(query.eventId))
                throw new Error('INVALID_ID');
            filters.eventId = query.eventId;
        }
        if (query.actorId) {
            if (!asId(query.actorId))
                throw new Error('INVALID_ID');
            filters.actorId = query.actorId;
        }
        if (actor.role === User_1.Role.ADMIN)
            return auditLog_repository_1.auditLogRepository.findLogs(filters);
        if (actor.role === User_1.Role.ORGANIZER)
            return auditLog_repository_1.auditLogRepository.findLogs({ ...filters, organizerId: actor.userId });
        throw new Error('FORBIDDEN');
    }
};
