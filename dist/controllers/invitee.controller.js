"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteeController = void 0;
const credential_service_1 = require("../services/credential.service");
const passNotice_service_1 = require("../services/passNotice.service");
const invitee_service_1 = require("../services/invitee.service");
const inviteeSet_service_1 = require("../services/inviteeSet.service");
const InviteeSet_1 = require("../models/InviteeSet");
const CREDENTIAL_REFUSALS = {
    INVITEE_NOT_FOUND: { status: 404, message: 'Guest not found or inaccessible' },
    EVENT_NOT_FOUND: { status: 404, message: 'Event not found or inaccessible' },
    FORBIDDEN: { status: 403, message: 'You are not allowed to manage access passes' },
    EVENT_NOT_ACTIVE: { status: 409, message: 'Access passes can only be changed while the event is published.' },
    NOT_ISSUED: { status: 409, message: 'This guest has no access pass yet. Send the invitation first.' },
    CREDENTIAL_EXPIRED: { status: 409, message: 'The admission window has closed, so a new pass would not work either.' },
    REPLACEMENT_NOT_ALLOWED: { status: 409, message: 'This pass was revoked because access was withdrawn, so it cannot be replaced from here.' },
    REVIEW_REQUIRED: { status: 409, message: 'This pass was revoked for another reason. Confirm that you have reviewed it before replacing it.' },
    NOT_ELIGIBLE: { status: 409, message: 'This guest is not eligible for admission under the event\'s RSVP rules, so no new pass was issued.' },
    NO_DELIVERY_CHANNEL: { status: 409, message: 'No earlier invitation reached this guest on any channel, so a replacement could not be delivered. Send the invitation instead.' },
    CONFLICT: { status: 409, message: 'The pass changed while you were replacing it. Reload and try again; nothing was changed.' },
    CARD_RENDER_FAILED: { status: 500, message: 'The new pass could not be prepared. The current pass is unchanged.' }
};
function sendSetError(res, next, error) {
    if (error?.statusCode && error.statusCode < 500) {
        res.status(error.statusCode).json({ success: false, ...(error.code ? { code: error.code } : {}), message: error.message });
        return;
    }
    next(error);
}
function sendCredentialError(res, next, error) {
    if (error?.message === 'INVALID_REASON') {
        res.status(400).json({ success: false, error: 'Bad Request', code: 'INVALID_REASON', message: error.detail || 'Invalid reason' });
        return;
    }
    const refusal = CREDENTIAL_REFUSALS[error?.message];
    if (refusal) {
        res.status(refusal.status).json({ success: false, code: error.message, message: refusal.message });
        return;
    }
    next(error);
}
const channelsOf = (notice) => notice ? { email: notice.email?.status, whatsapp: notice.whatsapp?.status } : undefined;
exports.inviteeController = {
    async revokeCredential(req, res, next) {
        try {
            const r = await credential_service_1.credentialService.revoke(req.user, req.params.inviteeId, req.body || {});
            if (!r.alreadyRevoked && r.notice)
                await credential_service_1.credentialService.startNotices(r.notice);
            res.status(200).json({ success: true, data: { inviteeId: req.params.inviteeId, credentialStatus: 'REVOKED', alreadyRevoked: r.alreadyRevoked, notice: channelsOf(r.notice) } });
        }
        catch (error) {
            sendCredentialError(res, next, error);
        }
    },
    async replaceCredential(req, res, next) {
        try {
            const r = await credential_service_1.credentialService.replace(req.user, req.params.inviteeId, req.body || {});
            res.status(200).json({ success: true, data: { inviteeId: req.params.inviteeId, credentialStatus: 'ACTIVE', version: r.credentialEvent.version, notice: channelsOf(r.notice) } });
        }
        catch (error) {
            sendCredentialError(res, next, error);
        }
    },
    async getCredentialHistory(req, res, next) {
        try {
            const data = await credential_service_1.credentialService.history(req.user, req.params.eventId, { inviteeId: typeof req.query.inviteeId === 'string' ? req.query.inviteeId : undefined });
            res.status(200).json({ success: true, data });
        }
        catch (error) {
            sendCredentialError(res, next, error);
        }
    },
    async getInviteeSets(req, res, next) {
        try {
            res.status(200).json({ success: true, data: await inviteeSet_service_1.inviteeSetService.list(req.user, req.params.eventId) });
        }
        catch (error) {
            sendSetError(res, next, error);
        }
    },
    async getSetMembers(req, res, next) {
        try {
            const data = await inviteeSet_service_1.inviteeSetService.members(req.user, req.params.eventId, req.params.setId, parseInt(req.query.page) || 1, parseInt(req.query.limit) || 50);
            res.status(200).json({ success: true, data });
        }
        catch (error) {
            sendSetError(res, next, error);
        }
    },
    async getSetAside(req, res, next) {
        try {
            const data = await inviteeSet_service_1.inviteeSetService.setAside(req.user, req.params.eventId, { q: typeof req.query.q === 'string' ? req.query.q : undefined, page: parseInt(req.query.page) || 1, limit: parseInt(req.query.limit) || 50 });
            res.status(200).json({ success: true, data });
        }
        catch (error) {
            sendSetError(res, next, error);
        }
    },
    async restoreSetAside(req, res, next) {
        try {
            const ids = Array.isArray(req.body?.inviteeIds) ? req.body.inviteeIds.filter((x) => typeof x === 'string') : [];
            const data = await inviteeSet_service_1.inviteeSetService.restore(req.user, req.params.eventId, ids);
            res.status(200).json({ success: true, data });
        }
        catch (error) {
            sendSetError(res, next, error);
        }
    },
    async retryPassNotices(req, res, next) {
        try {
            const user = req.user;
            // same authorization as reading the history: the owner or an admin of this event
            await credential_service_1.credentialService.history(user, req.params.eventId, { limit: 1 });
            const totals = await passNotice_service_1.passNoticeService.retry(req.params.eventId, { inviteeId: typeof req.body?.inviteeId === 'string' ? req.body.inviteeId : undefined, includeUnknown: req.body?.includeUnknown === true });
            res.status(200).json({ success: true, data: { attempted: totals } });
        }
        catch (error) {
            sendCredentialError(res, next, error);
        }
    },
    async createInvitee(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const invitee = await invitee_service_1.inviteeService.createInvitee(eventId, organizerId, req.body, req.user.role);
            res.status(201).json({ success: true, data: invitee });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'DUPLICATE_INVITEE') {
                res.status(409).json({ error: 'Conflict', message: 'Invitee already exists', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async getInvitees(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const page = Math.max(parseInt(req.query.page) || 1, 1);
            const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
            const checkInStatusParam = req.query.checkInStatus;
            const checkInStatus = checkInStatusParam === 'CHECKED_IN' || checkInStatusParam === 'PENDING' ? checkInStatusParam : undefined;
            const options = {
                page,
                limit,
                rsvpStatus: req.query.rsvpStatus,
                invitationStatus: req.query.invitationStatus,
                search: req.query.search,
                sessionId: req.query.sessionId,
                checkInStatus,
                sessionAccessId: req.query.sessionAccessId,
                invitation: req.query.invitation === 'SENT' || req.query.invitation === 'NOT_SENT' ? req.query.invitation : undefined,
            };
            const result = await invitee_service_1.inviteeService.getInvitees(eventId, organizerId, options, req.user.role);
            res.status(200).json({
                success: true,
                data: result.invitees,
                meta: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) || 1 }
            });
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
    async getInviteeById(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const inviteeId = req.params.inviteeId;
            const invitee = await invitee_service_1.inviteeService.getInviteeById(inviteeId, organizerId);
            res.status(200).json({ success: true, data: invitee });
        }
        catch (error) {
            if (error.message === 'INVITEE_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async updateInvitee(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const inviteeId = req.params.inviteeId;
            const invitee = await invitee_service_1.inviteeService.updateInvitee(inviteeId, organizerId, req.body);
            res.status(200).json({ success: true, data: invitee });
        }
        catch (error) {
            if (error.message === 'INVITEE_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
            }
            else if (error.message === 'DUPLICATE_INVITEE') {
                res.status(409).json({ error: 'Conflict', message: 'Invitee with this email or mobile already exists', details: [] });
            }
            else if (error.message === 'SET_LOCKED') {
                res.status(409).json({ success: false, code: 'SET_LOCKED', message: 'This guest belongs to an invitee list that invitations have already been sent from, so their details cannot be changed.' });
            }
            else {
                next(error);
            }
        }
    },
    async updateSessionAccess(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const inviteeId = req.params.inviteeId;
            const invitee = await invitee_service_1.inviteeService.updateSessionAccess(inviteeId, organizerId, req.body.sessionAccess);
            res.status(200).json({ success: true, data: invitee });
        }
        catch (error) {
            if (error.message === 'INVITEE_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
            }
            else if (error.message === 'INVALID_SESSIONS') {
                res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async bulkUpdateSessionAccess(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            const result = await invitee_service_1.inviteeService.bulkUpdateSessionAccess(eventId, organizerId, req.body.inviteeIds, req.body.sessionAccess);
            res.status(200).json({ success: true, data: result });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else if (error.message === 'INVALID_INVITEES') {
                res.status(400).json({ error: 'Bad Request', message: 'One or more invitees are invalid or belong to a different event', details: [] });
            }
            else if (error.message === 'INVALID_SESSIONS') {
                res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
            }
            else {
                next(error);
            }
        }
    },
    async deleteInvitee(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const inviteeId = req.params.inviteeId;
            const invitee = await invitee_service_1.inviteeService.deleteInvitee(inviteeId, organizerId);
            res.status(200).json({ success: true, data: { inviteeId: invitee._id, deleted: true } });
        }
        catch (error) {
            if (error.message === 'INVITEE_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Invitee not found or inaccessible', details: [] });
            }
            else if (error.message === 'SET_LOCKED') {
                res.status(409).json({ success: false, code: 'SET_LOCKED', message: 'This guest belongs to an invitee list that invitations have already been sent from, so they cannot be removed.' });
            }
            else if (error.message === 'HAS_HISTORY') {
                res.status(409).json({ success: false, code: 'HAS_HISTORY', message: 'This guest has been invited, has answered, or has attended, so they cannot be removed. Their history is kept.' });
            }
            else {
                next(error);
            }
        }
    },
    async importExcel(req, res, next) {
        try {
            const organizerId = req.user.userId;
            const eventId = req.params.eventId;
            if (!req.file) {
                res.status(400).json({ error: 'Bad Request', message: 'No file uploaded', details: [] });
                return;
            }
            const rawSessionId = (req.body?.sessionId || req.query.sessionId || '');
            if (rawSessionId && !/^[0-9a-fA-F]{24}$/.test(rawSessionId)) {
                res.status(400).json({ success: false, message: 'Invalid sessionId format' });
                return;
            }
            const rawMode = String(req.body?.mode || req.query.mode || 'REPLACE').toUpperCase();
            if (rawMode !== InviteeSet_1.ImportMode.REPLACE && rawMode !== InviteeSet_1.ImportMode.APPEND) {
                res.status(400).json({ success: false, message: 'mode must be REPLACE or APPEND' });
                return;
            }
            const result = await invitee_service_1.inviteeService.processExcelImport(eventId, organizerId, req.file.buffer, {
                mode: rawMode,
                fileName: req.file.originalname,
                sessionId: rawSessionId || undefined,
                role: req.user.role
            });
            res.status(200).json({ success: true, data: result });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND') {
                res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
            }
            else {
                next(error);
            }
        }
    }
};
