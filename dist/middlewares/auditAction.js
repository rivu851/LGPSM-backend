"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditAction = auditAction;
const auditLog_service_1 = require("../services/auditLog.service");
const Invitee_1 = require("../models/Invitee");
const Session_1 = require("../models/Session");
const SystemUserAssignment_1 = require("../models/SystemUserAssignment");
const OWNER_MODELS = { Invitee: Invitee_1.Invitee, Session: Session_1.Session, SystemUserAssignment: SystemUserAssignment_1.SystemUserAssignment };
const isObj = (v) => !!v && typeof v === 'object';
/**
 * Route-level audit trail. Mount after authenticate/authorizeRoles so the actor is known. It records who did what to
 * which entity and whether it worked (HTTP outcome), never request bodies: only the *names* of the fields that changed.
 */
function auditAction(opts) {
    return async (req, res, next) => {
        const user = req.user;
        const rid = req.requestId;
        let captured;
        const json = res.json.bind(res);
        res.json = ((body) => { captured = body; return json(body); });
        const params = req.params;
        let entityId = opts.entityParam ? params[opts.entityParam] : undefined;
        let eventId = (opts.eventParam && params[opts.eventParam]) || (isObj(req.body) ? req.body.eventId : undefined);
        if (opts.eventOf && entityId && !eventId) {
            try {
                const row = await OWNER_MODELS[opts.eventOf].findById(entityId).select('eventId').lean();
                eventId = row?.eventId;
            }
            catch { /* an unknown id fails in the handler */ }
        }
        if (opts.entityType === 'Event' && !eventId)
            eventId = entityId;
        const baseMeta = () => ({
            method: req.method,
            route: `${req.baseUrl}${req.route?.path === '/' ? '' : req.route?.path || ''}`,
            changedFields: isObj(req.body) ? Object.keys(req.body).slice(0, 30) : []
        });
        const entry = (status, organizerId) => ({
            actorId: user?.userId, actorRole: user?.role, eventId, organizerId, action: opts.action,
            entityType: opts.entityType, entityId, status, description: opts.describe, requestId: rid, metadata: baseMeta()
        });
        let organizerId = await auditLog_service_1.auditLogService.organizerOfEvent(eventId).catch(() => undefined);
        // An organizer's own activity (e.g. managing their staff accounts) belongs to their tenant even without an event
        if (!organizerId && user?.role === 'ORGANIZER')
            organizerId = user.userId;
        let pendingId;
        if (opts.critical) {
            try {
                pendingId = (await auditLog_service_1.auditLogService.logAction(entry('PENDING', organizerId)))._id;
            }
            catch (error) {
                console.error('Audit write failed, refusing critical action:', opts.action, error?.message);
                return res.status(503).json({ success: false, error: 'Service Unavailable', message: 'This action could not be recorded, so it was not performed. Please try again.' });
            }
        }
        res.on('finish', async () => {
            const ok = res.statusCode < 400;
            const data = isObj(captured) ? captured.data : undefined;
            entityId = entityId || (isObj(data) ? data._id || data.id || data.eventId : undefined);
            eventId = eventId || (isObj(data) ? data.eventId : undefined) || (opts.entityType === 'Event' ? entityId : undefined);
            if (!organizerId && eventId)
                organizerId = await auditLog_service_1.auditLogService.organizerOfEvent(eventId).catch(() => undefined);
            if (!organizerId && user?.role === 'ORGANIZER')
                organizerId = user.userId;
            const metadata = { ...baseMeta(), httpStatus: res.statusCode, ...(opts.meta ? opts.meta(req, captured) : {}) };
            if (pendingId) {
                await auditLog_service_1.auditLogService.finish(pendingId, { status: ok ? 'SUCCESS' : 'FAILED', eventId, organizerId, entityId, metadata });
            }
            else {
                await auditLog_service_1.auditLogService.record({ ...entry(ok ? 'SUCCESS' : 'FAILED', organizerId), eventId, entityId, metadata });
            }
        });
        next();
    };
}
