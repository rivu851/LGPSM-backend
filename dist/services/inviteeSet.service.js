"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteeSetService = exports.lockedSetKeys = exports.neverAttempted = exports.deliveryStateOf = exports.setKeyOf = exports.LEGACY_SET = void 0;
exports.loadActivity = loadActivity;
exports.lockReasonsBySet = lockReasonsBySet;
exports.withEventLock = withEventLock;
exports.restoreBlock = restoreBlock;
const mongoose_1 = __importDefault(require("mongoose"));
const Invitee_1 = require("../models/Invitee");
const InviteeSet_1 = require("../models/InviteeSet");
const Invitation_1 = require("../models/Invitation");
const CheckIn_1 = require("../models/CheckIn");
const CredentialEvent_1 = require("../models/CredentialEvent");
const Event_1 = require("../models/Event");
const User_1 = require("../models/User");
const auditLog_service_1 = require("./auditLog.service");
const whatsapp_service_1 = require("./whatsapp.service");
// Guests without a tracked list (added by hand, or before lists were tracked) are treated as one "earlier" list.
exports.LEGACY_SET = 'legacy';
const setKeyOf = (inv) => (inv.inviteeSetId ? String(inv.inviteeSetId) : exports.LEGACY_SET);
exports.setKeyOf = setKeyOf;
const deliveryStateOf = (a) => (a.sent ? 'SENT' : a.unknown ? 'UNKNOWN' : a.failed ? 'FAILED' : 'NOT_SENT');
exports.deliveryStateOf = deliveryStateOf;
/** Only a guest nothing has ever happened to can be set aside. */
const neverAttempted = (a) => !a.attempted && !a.rsvp && !a.checkedIn;
exports.neverAttempted = neverAttempted;
async function loadActivity(eventId, invitees) {
    const eid = new mongoose_1.default.Types.ObjectId(String(eventId));
    const [invitations, checked, credentialed] = await Promise.all([
        Invitation_1.Invitation.find({ eventId: eid }).select('inviteeId status').lean(),
        CheckIn_1.CheckIn.distinct('inviteeId', { eventId: eid }),
        CredentialEvent_1.CredentialEvent.distinct('inviteeId', { eventId: eid })
    ]);
    const byInvitee = new Map();
    for (const row of invitations) {
        const k = String(row.inviteeId);
        byInvitee.set(k, [...(byInvitee.get(k) || []), row.status]);
    }
    const checkedIn = new Set(checked.map(String));
    const hasCredential = new Set(credentialed.map(String));
    const out = new Map();
    for (const inv of invitees) {
        const id = String(inv._id);
        const rows = byInvitee.get(id) || [];
        const sent = inv.invitationStatus === Invitee_1.InvitationStatus.SENT || rows.includes(Invitation_1.InvitationDeliveryStatus.SENT);
        const unknown = !sent && rows.includes(Invitation_1.InvitationDeliveryStatus.PENDING);
        const failed = !sent && !unknown && (inv.invitationStatus === Invitee_1.InvitationStatus.FAILED || rows.includes(Invitation_1.InvitationDeliveryStatus.FAILED));
        out.set(id, {
            sent, failed, unknown,
            attempted: sent || failed || unknown || rows.length > 0 || !!inv.qrTokenHash || hasCredential.has(id),
            rsvp: inv.rsvpStatus !== Invitee_1.RsvpStatus.PENDING,
            checkedIn: checkedIn.has(id)
        });
    }
    return out;
}
/** The authoritative lock state, from the server's records: a successful dispatch, an RSVP, or a check-in locks a list. */
function lockReasonsBySet(invitees, activity) {
    const out = new Map();
    for (const inv of invitees) {
        const a = activity.get(String(inv._id));
        if (!a || !(a.sent || a.rsvp || a.checkedIn))
            continue;
        const k = (0, exports.setKeyOf)(inv);
        const r = out.get(k) || { sent: 0, rsvp: 0, checkedIn: 0 };
        if (a.sent)
            r.sent++;
        if (a.rsvp)
            r.rsvp++;
        if (a.checkedIn)
            r.checkedIn++;
        out.set(k, r);
    }
    return out;
}
const lockedSetKeys = (invitees, activity) => new Set(lockReasonsBySet(invitees, activity).keys());
exports.lockedSetKeys = lockedSetKeys;
// Import and restore both read "who is on the list" and then write; running them one at a time per event stops a restore
// and an upload from creating the same person twice. (In-process: a single backend instance; see docs for the limit.)
const chains = new Map();
function withEventLock(eventId, fn) {
    const prev = chains.get(eventId) || Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    chains.set(eventId, tail);
    tail.then(() => { if (chains.get(eventId) === tail)
        chains.delete(eventId); });
    return run;
}
const mobileKey = (m) => whatsapp_service_1.whatsappService.normalizePhoneNumber(m);
const fail = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code, message });
/** Owner organizer or admin only. System Users (and anyone else) are refused here as well as at the route. */
async function manageableEvent(actor, eventId) {
    if (!mongoose_1.default.Types.ObjectId.isValid(eventId))
        throw fail(400, 'Invalid event id');
    if (actor.role !== User_1.Role.ADMIN && actor.role !== User_1.Role.ORGANIZER)
        throw fail(403, 'Not permitted to manage invitee lists');
    const event = actor.role === User_1.Role.ADMIN ? await Event_1.Event.findById(eventId) : await Event_1.Event.findOne({ _id: eventId, organizerId: actor.userId });
    if (!event)
        throw fail(404, 'Event not found or inaccessible');
    return event;
}
const nameMap = async (ids) => {
    const valid = [...new Set(ids.filter(Boolean).map(String))].filter((i) => mongoose_1.default.Types.ObjectId.isValid(i));
    const users = valid.length ? await User_1.User.find({ _id: { $in: valid } }).select('fullName role').lean() : [];
    return new Map(users.map((u) => [String(u._id), { id: String(u._id), name: u.fullName, role: u.role }]));
};
const REASON_TEXT = { SUPERSEDED_BY_UPLOAD: 'Replaced by a newer upload' };
exports.inviteeSetService = {
    async list(actor, eventId) {
        await manageableEvent(actor, eventId);
        const eid = new mongoose_1.default.Types.ObjectId(eventId);
        const [invitees, sets] = await Promise.all([
            Invitee_1.Invitee.find({ eventId: eid }).select('inviteeSetId invitationStatus rsvpStatus qrTokenHash').lean(),
            InviteeSet_1.InviteeSet.find({ eventId: eid }).sort({ createdAt: 1 }).lean()
        ]);
        const activity = await loadActivity(eid, invitees);
        const reasons = lockReasonsBySet(invitees, activity);
        const aside = await Invitee_1.Invitee.aggregate([{ $match: { eventId: eid, archivedAt: { $ne: null } } }, { $group: { _id: { $ifNull: ['$inviteeSetId', exports.LEGACY_SET] }, n: { $sum: 1 } } }]).option({ includeArchived: true });
        const asideBySet = new Map(aside.map((r) => [String(r._id), r.n]));
        const rows = new Map();
        for (const inv of invitees) {
            const k = (0, exports.setKeyOf)(inv);
            const r = rows.get(k) || { total: 0, sent: 0, notSent: 0, failed: 0, unknown: 0, rsvp: 0, checkedIn: 0 };
            const a = activity.get(String(inv._id));
            r.total++;
            const state = (0, exports.deliveryStateOf)(a);
            if (state === 'SENT')
                r.sent++;
            else if (state === 'UNKNOWN')
                r.unknown++;
            else if (state === 'FAILED')
                r.failed++;
            else
                r.notSent++;
            if (a.rsvp)
                r.rsvp++;
            if (a.checkedIn)
                r.checkedIn++;
            rows.set(k, r);
        }
        const people = await nameMap(sets.map((s) => s.createdBy));
        const shape = (id, base) => {
            const r = rows.get(id) || { total: 0, sent: 0, notSent: 0, failed: 0, unknown: 0, rsvp: 0, checkedIn: 0 };
            const why = reasons.get(id);
            const locked = !!why;
            return {
                id, ...base, ...r, unsent: r.notSent, setAside: asideBySet.get(id) || 0, locked,
                // why the list is in this state (empty when Open)
                lockReasons: why ? { sentGuests: why.sent, answeredRsvp: why.rsvp, checkedIn: why.checkedIn } : null,
                // guests a Replace could still set aside: never attempted, and only in an Open list
                replaceableGuests: locked ? 0 : r.notSent
            };
        };
        const out = sets.map((s) => shape(String(s._id), {
            name: s.name, source: 'EXCEL', mode: s.mode, sessionId: s.sessionId ? String(s.sessionId) : null, createdAt: s.createdAt,
            uploadedBy: s.createdBy ? people.get(String(s.createdBy)) || null : null, importedCount: s.importedCount ?? null
        }));
        if (rows.has(exports.LEGACY_SET) || asideBySet.has(exports.LEGACY_SET)) {
            out.unshift(shape(exports.LEGACY_SET, { name: 'Earlier invitees', source: 'MANUAL', mode: 'APPEND', sessionId: null, createdAt: null, uploadedBy: null, importedCount: null }));
        }
        const archivedCount = [...asideBySet.values()].reduce((a, b) => a + b, 0);
        return { sets: out, archivedCount, hasSent: out.some((s) => s.locked) };
    },
    /** The guests currently in one list, with each guest's delivery state. No tokens, no credentials. */
    async members(actor, eventId, setId, page = 1, limit = 50) {
        await manageableEvent(actor, eventId);
        if (setId !== exports.LEGACY_SET && !mongoose_1.default.Types.ObjectId.isValid(setId))
            throw fail(400, 'Invalid list id');
        const eid = new mongoose_1.default.Types.ObjectId(eventId);
        const filter = { eventId: eid, inviteeSetId: setId === exports.LEGACY_SET ? null : new mongoose_1.default.Types.ObjectId(setId) };
        const lim = Math.min(Math.max(limit, 1), 100);
        const [guests, total] = await Promise.all([
            Invitee_1.Invitee.find(filter).select('name email mobile invitationStatus rsvpStatus qrTokenHash inviteeSetId').sort({ name: 1 }).skip((Math.max(page, 1) - 1) * lim).limit(lim).lean(),
            Invitee_1.Invitee.countDocuments(filter)
        ]);
        const activity = await loadActivity(eid, guests);
        return {
            total, page, limit: lim,
            members: guests.map((g) => {
                const a = activity.get(String(g._id));
                return { id: String(g._id), name: g.name, email: g.email || null, mobile: g.mobile || null, delivery: (0, exports.deliveryStateOf)(a), rsvpStatus: g.rsvpStatus, checkedIn: a.checkedIn };
            })
        };
    },
    /** Set-aside guests of one event, apart from the active list. Owner organizer and admin only. */
    async setAside(actor, eventId, opts = {}) {
        const event = await manageableEvent(actor, eventId);
        const eid = new mongoose_1.default.Types.ObjectId(eventId);
        const filter = { eventId: eid, archivedAt: { $ne: null } };
        if (opts.q?.trim()) {
            const rx = new RegExp(opts.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ name: rx }, { email: rx }, { mobile: rx }];
        }
        const page = Math.max(opts.page || 1, 1), limit = Math.min(Math.max(opts.limit || 50, 1), 100);
        const [guests, total] = await Promise.all([
            Invitee_1.Invitee.find(filter).setOptions({ includeArchived: true }).select('name email mobile inviteeSetId archivedAt archivedReason supersededBySetId archivedBy archivedByRole').sort({ archivedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            Invitee_1.Invitee.countDocuments(filter).setOptions({ includeArchived: true })
        ]);
        const setIds = [...new Set(guests.flatMap((g) => [g.inviteeSetId, g.supersededBySetId]).filter(Boolean).map(String))];
        const sets = setIds.length ? await InviteeSet_1.InviteeSet.find({ _id: { $in: setIds } }).select('name').lean() : [];
        const setName = new Map(sets.map((s) => [String(s._id), s.name]));
        const people = await nameMap(guests.map((g) => g.archivedBy));
        return {
            restorable: restoreBlock(event) === null,
            notRestorableReason: restoreBlock(event),
            total, page, limit,
            guests: guests.map((g) => ({
                id: String(g._id), name: g.name, email: g.email || null, mobile: g.mobile || null,
                fromSet: { id: g.inviteeSetId ? String(g.inviteeSetId) : exports.LEGACY_SET, name: g.inviteeSetId ? setName.get(String(g.inviteeSetId)) || 'Removed list' : 'Earlier invitees' },
                setAsideAt: g.archivedAt, reason: g.archivedReason || null, reasonText: g.archivedReason ? REASON_TEXT[g.archivedReason] || g.archivedReason : null,
                replacedBy: g.supersededBySetId ? { id: String(g.supersededBySetId), name: setName.get(String(g.supersededBySetId)) || 'Removed list' } : null,
                setAsideBy: g.archivedBy ? people.get(String(g.archivedBy)) || null : null
            }))
        };
    },
    /**
     * Brings set-aside guests back as the SAME records (same _id and list), Not Sent, with no invitation and no pass.
     * Each guest is checked on its own against the active list (normalised email / phone, never the name) and the outcome is
     * reported per guest. Safe to repeat: a guest that is already active is reported as such and changed no further.
     */
    async restore(actor, eventId, inviteeIds) {
        const event = await manageableEvent(actor, eventId);
        const blocked = restoreBlock(event);
        if (blocked)
            throw fail(409, blocked, 'EVENT_NOT_ACTIVE');
        const ids = [...new Set(inviteeIds.map(String))];
        if (ids.length === 0 || ids.length > 200 || ids.some((i) => !mongoose_1.default.Types.ObjectId.isValid(i)))
            throw fail(400, 'Choose between 1 and 200 valid guests');
        return withEventLock(eventId, async () => {
            const eid = new mongoose_1.default.Types.ObjectId(eventId);
            const active = await Invitee_1.Invitee.find({ eventId: eid }).select('name email mobile').lean();
            const byEmail = new Map(), byMobile = new Map();
            const index = (g) => { if (g.email)
                byEmail.set(g.email.toLowerCase(), g); const m = mobileKey(g.mobile); if (m)
                byMobile.set(m, g); };
            active.forEach(index);
            const results = [];
            const auditBase = { actorId: actor.userId, actorRole: actor.role, eventId, organizerId: event.organizerId, entityType: 'Invitee' };
            for (const id of ids) {
                const g = await Invitee_1.Invitee.findOne({ _id: id, eventId: eid }).setOptions({ includeArchived: true });
                if (!g) {
                    results.push({ id, status: 'NOT_FOUND' });
                    continue;
                }
                if (!g.archivedAt) {
                    results.push({ id, status: 'ALREADY_ACTIVE' });
                    continue;
                }
                const emailHit = g.email ? byEmail.get(String(g.email).toLowerCase()) : undefined;
                const mobileHit = mobileKey(g.mobile) ? byMobile.get(mobileKey(g.mobile)) : undefined;
                const hit = emailHit || mobileHit;
                if (hit) {
                    const conflictsWith = { id: String(hit._id), name: hit.name, matchedOn: (emailHit ? 'email' : 'mobile') };
                    results.push({ id, status: 'DUPLICATE_ACTIVE', conflictsWith });
                    await auditLog_service_1.auditLogService.record({ ...auditBase, action: 'INVITEE_RESTORE_CONFLICT', entityId: id, status: 'FAILED', description: 'Restoration refused: an active guest has the same email or mobile', metadata: { reason: 'DUPLICATE_ACTIVE', matchedOn: conflictsWith.matchedOn, conflictingInviteeId: conflictsWith.id } });
                    continue;
                }
                const snapshot = { archivedAt: g.archivedAt, reason: g.archivedReason, supersededBySetId: g.supersededBySetId || null, archivedBy: g.archivedBy || null, archivedByRole: g.archivedByRole || null };
                const now = new Date();
                const done = await Invitee_1.Invitee.updateOne({ _id: g._id, archivedAt: { $ne: null } }, {
                    $set: { archivedAt: null, supersededBySetId: null, archivedBy: null, archivedByRole: null, restoredAt: now, restoredBy: actor.userId },
                    $unset: { archivedReason: '' },
                    $push: { setAsideHistory: { ...snapshot, restoredAt: now, restoredBy: new mongoose_1.default.Types.ObjectId(actor.userId) } }
                });
                if (done.modifiedCount !== 1) {
                    results.push({ id, status: 'ALREADY_ACTIVE' });
                    continue;
                }
                // second look: something else may have created the same person between the check and the write; if so, undo
                const rival = (await Invitee_1.Invitee.find({ eventId: eid, _id: { $ne: g._id }, $or: [...(g.email ? [{ email: String(g.email).toLowerCase() }] : []), ...(g.mobile ? [{ mobile: g.mobile }] : [])] }).limit(1).lean())[0];
                if (rival) {
                    await Invitee_1.Invitee.updateOne({ _id: g._id }, {
                        $set: { archivedAt: snapshot.archivedAt, archivedReason: snapshot.reason, supersededBySetId: snapshot.supersededBySetId, archivedBy: snapshot.archivedBy, archivedByRole: snapshot.archivedByRole, restoredAt: null, restoredBy: null },
                        $pop: { setAsideHistory: 1 }
                    });
                    results.push({ id, status: 'DUPLICATE_ACTIVE', conflictsWith: { id: String(rival._id), name: rival.name, matchedOn: g.email && rival.email === String(g.email).toLowerCase() ? 'email' : 'mobile' } });
                    continue;
                }
                index(g);
                results.push({ id, status: 'RESTORED' });
                await auditLog_service_1.auditLogService.record({ ...auditBase, action: 'INVITEE_RESTORED', entityId: id, description: 'Set-aside guest restored to the active list as Not Sent', metadata: { setId: g.inviteeSetId ? String(g.inviteeSetId) : exports.LEGACY_SET, wasSetAsideAt: snapshot.archivedAt, reason: snapshot.reason } });
            }
            const count = (s) => results.filter((r) => r.status === s).length;
            return { restored: count('RESTORED'), alreadyActive: count('ALREADY_ACTIVE'), refused: count('DUPLICATE_ACTIVE'), notFound: count('NOT_FOUND'), results };
        });
    }
};
/** Why guests cannot be restored for this event right now, or null. */
function restoreBlock(event) {
    if (event.status === Event_1.EventStatus.CANCELLED)
        return 'Guests cannot be restored for a cancelled event.';
    if (event.status === Event_1.EventStatus.COMPLETED || event.closedAt)
        return 'Guests cannot be restored for a completed or closed event.';
    return null;
}
