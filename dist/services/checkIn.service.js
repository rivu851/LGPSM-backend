"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkInService = exports.AdmissionError = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const CheckIn_1 = require("../models/CheckIn");
const Event_1 = require("../models/Event");
const Invitee_1 = require("../models/Invitee");
const Session_1 = require("../models/Session");
const User_1 = require("../models/User");
const SystemUserAssignment_1 = require("../models/SystemUserAssignment");
const checkIn_repository_1 = require("../repositories/checkIn.repository");
const invitation_util_1 = require("../utils/invitation.util");
const Invitation_1 = require("../models/Invitation");
const CredentialEvent_1 = require("../models/CredentialEvent");
const qrPayload_1 = require("../utils/qrPayload");
const sessionAccess_1 = require("../utils/sessionAccess");
const clock_1 = require("../utils/clock");
const admissionWindow_1 = require("../utils/admissionWindow");
/**
 * Core service for event check-in operations (QR scanning and manual entry).
 *
 * Order of checks (first failure wins, nothing is written until all pass):
 *   1 staff identity (route)  2 assignment to the event  3 event status  4 admission window (server clock)
 *   5 credential (known, current, not revoked)  6 required session / session window / guest access
 *   7 repeat-entry rules  8 attendance record (unique index decides concurrent scans)
 *
 * Security & Access Rules:
 * - Admin/Organizer: Full check-in access for owned events.
 * - System User (Staff): Allowed only if assigned to the event and specific session.
 * - Token Validation: Parses QR payloads securely using `parseInvitationQrPayload` and hashes tokens
 *   to query MongoDB (`qrTokenHash`). Superseded tokens from older invitation resends are rejected (`QR_TOKEN_SUPERSEDED`).
 * - RSVP Eligibility: Rejects guests with DECLINED/PENDING status based on event RSVP settings.
 * - Access Control:
 *   - ONLY_ONCE: Allows only one check-in per session (`ONLY_ONCE_VIOLATION`).
 *   - NO_RESTRICTION: Logs check-ins but rejects duplicate attempts if already recorded.
 *   - Primary Session Rule: When primary session `validateAgainstOtherSessions` is active, guests must
 *     check in to the primary session first before entering secondary sessions (`PRIMARY_SESSION_CHECKIN_REQUIRED`).
 */
const QR_REJECTIONS = {
    EMPTY: 'QR_PAYLOAD_REQUIRED',
    UNSUPPORTED_FORMAT: 'QR_FORMAT_UNSUPPORTED',
    UNTRUSTED_URL: 'QR_URL_UNTRUSTED',
    PREVIEW_SAMPLE: 'QR_PREVIEW_SAMPLE',
};
let transactionSupport;
/** Transactions need a replica set / sharded cluster; a standalone mongod rejects them. Asked once per process. */
function supportsTransactions() {
    transactionSupport ??= (async () => {
        try {
            const hello = await mongoose_1.default.connection.db.admin().command({ hello: 1 });
            return !!(hello.setName || hello.msg === 'isdbgrid');
        }
        catch {
            return false;
        }
    })();
    return transactionSupport;
}
/** A time-based refusal that carries the window so the response can say when check-in opens or closed. */
class AdmissionError extends Error {
    code;
    opensAt;
    closesAt;
    constructor(code, opensAt, closesAt) {
        super(code);
        this.code = code;
        this.opensAt = opensAt;
        this.closesAt = closesAt;
    }
    /** Staff-facing sentence; times are written in the platform timezone */
    describe() {
        switch (this.code) {
            case 'ADMISSION_NOT_OPEN': return `Check-in has not opened yet. It opens on ${(0, admissionWindow_1.formatAdmissionTime)(this.opensAt)}.`;
            case 'SESSION_NOT_OPEN': return `Check-in for this session has not opened yet. It opens on ${(0, admissionWindow_1.formatAdmissionTime)(this.opensAt)}.`;
            case 'SESSION_CLOSED': return `Check-in for this session ended on ${(0, admissionWindow_1.formatAdmissionTime)(this.closesAt)}.`;
            case 'CREDENTIAL_EXPIRED': return `This access pass has expired. Event admission ended on ${(0, admissionWindow_1.formatAdmissionTime)(this.closesAt)}.`;
            default: return `Event admission has ended. It closed on ${(0, admissionWindow_1.formatAdmissionTime)(this.closesAt)}.`;
        }
    }
}
exports.AdmissionError = AdmissionError;
exports.checkInService = {
    /**
     * Processes a QR scan check-in attempt.
     * Validates QR payload, token hash lookup, staff assignment, RSVP eligibility, and session access rules.
     */
    async scanCheckIn(actor, dto) {
        const parsed = (0, qrPayload_1.parseInvitationQrPayload)(dto.qrCode);
        if (!parsed.ok) {
            throw new Error(QR_REJECTIONS[parsed.reason]);
        }
        // The server clock decides every time-based rule; the device's clock is never consulted
        const now = clock_1.clock.now();
        // When the scanner names the event, who may act and what state the event is in are settled before the pass is
        // looked at, so a stranger or a closed door learns nothing about the credential.
        let context = dto.eventId ? await this.validateActorAndEvent(actor, dto.eventId) : null;
        if (context)
            this.assertEventAdmitting(context.event, now, true);
        const tokenHash = (0, invitation_util_1.hashToken)(parsed.token);
        const invitee = await Invitee_1.Invitee.findOne({ qrTokenHash: tokenHash });
        if (!invitee) {
            // A token from an earlier send/resend is replaced by the newest one
            const superseded = (await Invitation_1.Invitation.exists({ tokenHash })) || (await CredentialEvent_1.CredentialEvent.exists({ tokenHash }));
            throw new Error(superseded ? 'QR_TOKEN_SUPERSEDED' : 'INVALID_QR_TOKEN');
        }
        const eventId = invitee.eventId.toString();
        if (dto.eventId && dto.eventId !== eventId) {
            throw new Error('EVENT_MISMATCH');
        }
        if (!context) {
            context = await this.validateActorAndEvent(actor, eventId);
            this.assertEventAdmitting(context.event, now, true);
        }
        const { event, assignment } = context;
        return this.admit({ actor, event, assignment, invitee, sessionId: dto.sessionId, method: CheckIn_1.CheckInMethod.QR, now });
    },
    async manualCheckIn(actor, dto) {
        if (!dto.eventId) {
            throw new Error('EVENT_ID_REQUIRED');
        }
        const now = clock_1.clock.now();
        const { event, assignment } = await this.validateActorAndEvent(actor, dto.eventId);
        this.assertEventAdmitting(event, now, false);
        let invitee = null;
        if (dto.inviteeId) {
            invitee = await Invitee_1.Invitee.findOne({ _id: dto.inviteeId, eventId: dto.eventId });
        }
        else if (dto.email) {
            invitee = await Invitee_1.Invitee.findOne({ eventId: dto.eventId, email: dto.email.trim().toLowerCase() });
        }
        else if (dto.mobile) {
            invitee = await Invitee_1.Invitee.findOne({ eventId: dto.eventId, mobile: dto.mobile.trim() });
        }
        if (!invitee) {
            throw new Error('INVITEE_NOT_FOUND');
        }
        return this.admit({ actor, event, assignment, invitee, sessionId: dto.sessionId, method: CheckIn_1.CheckInMethod.MANUAL, now });
    },
    /**
     * Steps 5-8 shared by QR and manual entry. Everything that can refuse runs before the single write, and the write
     * itself is guarded by the unique {event, invitee, session} index, so two scans racing each other produce one
     * attendance record and one refusal.
     */
    async admit(args) {
        const { actor, event, assignment, invitee, sessionId, method, now } = args;
        const eventId = String(event._id);
        if (invitee.credentialRevokedAt) {
            throw new Error('CREDENTIAL_REVOKED');
        }
        // Staff limited to certain sessions must say which one: leaving it out would otherwise be an event-wide entry that
        // skips the restriction.
        if (actor.role === User_1.Role.SYSTEM_USER && assignment?.sessionIds?.length > 0 && !sessionId) {
            throw new Error('SESSION_REQUIRED');
        }
        if (sessionId) {
            await this.validateStaffSessionAccess(actor, assignment, sessionId);
        }
        await this.validateInviteeEligibility(invitee, event);
        let session = null;
        if (sessionId) {
            session = await this.validateSessionAndRules(invitee, eventId, sessionId, now);
            // "No restriction": a second scan of the same pass is allowed
            if (session._existingCheckIn && session.accessControl === Session_1.AccessControl.NO_RESTRICTION) {
                return this.recordRepeatEntry(event, session._existingCheckIn, invitee, session, now);
            }
        }
        else {
            const existing = await checkIn_repository_1.checkInRepository.findEventWideCheckIn(invitee._id.toString(), eventId);
            if (existing) {
                throw new Error('DUPLICATE_CHECKIN');
            }
        }
        // A duplicate key (11000) from a concurrent scan surfaces as "already checked in" in the controller
        let checkIn;
        try {
            checkIn = await this.commitAdmission(event, {
                eventId: new mongoose_1.default.Types.ObjectId(eventId),
                inviteeId: invitee._id,
                sessionId: sessionId ? new mongoose_1.default.Types.ObjectId(sessionId) : null,
                checkInMethod: method,
                checkedInBy: new mongoose_1.default.Types.ObjectId(actor.userId),
                checkInAt: now
            }, now, method === CheckIn_1.CheckInMethod.QR);
        }
        catch (e) {
            // two scans of a NO_RESTRICTION pass at the same instant: the loser is a repeat entry on the winner's record
            if (e?.code === 11000 && session?.accessControl === Session_1.AccessControl.NO_RESTRICTION) {
                const winner = await checkIn_repository_1.checkInRepository.findByInviteeAndSession(invitee._id.toString(), String(sessionId));
                if (winner)
                    return this.recordRepeatEntry(event, winner, invitee, session, now);
            }
            throw e;
        }
        return this.formatCheckInResponse(checkIn, invitee, session);
    },
    /**
     * The one place an attendance record is written. Reading the event's status earlier and inserting later would leave a gap
     * in which a cancel/close could commit in between, so the insert is tied to the event document itself:
     *
     *  - Where MongoDB supports transactions (Atlas, any replica set) the insert runs in a transaction that FIRST updates the
     *    event (`admissionSeq`+1, only while it is PUBLISHED). Cancel and close update that same document, so MongoDB makes the
     *    two conflict and serialises them: either the check-in commits first and is legitimate attendance, or the cancel/close
     *    commits first and the check-in's conditional update matches nothing, so it is refused and nothing is written.
     *  - Where it does not (a standalone mongod used in local development), the event is claimed the same way, the record is
     *    inserted, and the event is read again; if it is no longer open the just-written record is removed and the scan refused.
     *    That removes an attendance row that was never acknowledged to anyone, but it is not crash-safe like a transaction.
     */
    async commitAdmission(event, data, now, qr) {
        const eventId = event._id;
        const refuseClosed = async (session) => {
            const fresh = await Event_1.Event.findById(eventId).session(session ?? null);
            this.assertEventAdmitting(fresh ?? event, now, qr);
            throw new Error('EVENT_NOT_PUBLISHED');
        };
        if (await supportsTransactions()) {
            const session = await mongoose_1.default.startSession();
            try {
                let created;
                await session.withTransaction(async () => {
                    const gate = await Event_1.Event.findOneAndUpdate({ _id: eventId, status: Event_1.EventStatus.PUBLISHED }, { $inc: { admissionSeq: 1 } }, { new: true, session, timestamps: false });
                    if (!gate)
                        await refuseClosed(session);
                    // the window is judged on the event exactly as this transaction sees it (it may have just been changed)
                    this.assertEventAdmitting(gate, now, qr);
                    const [doc] = await CheckIn_1.CheckIn.create([data], { session });
                    created = doc;
                });
                return created;
            }
            finally {
                await session.endSession();
            }
        }
        const claimed = await Event_1.Event.updateOne({ _id: eventId, status: Event_1.EventStatus.PUBLISHED }, { $inc: { admissionSeq: 1 } }, { timestamps: false });
        if (!claimed.matchedCount)
            await refuseClosed();
        const created = await checkIn_repository_1.checkInRepository.create(data);
        const stillOpen = await Event_1.Event.exists({ _id: eventId, status: Event_1.EventStatus.PUBLISHED });
        if (!stillOpen) {
            await CheckIn_1.CheckIn.deleteOne({ _id: created._id });
            await refuseClosed();
        }
        return created;
    },
    /**
     * Event status and admission window. `qr` only changes which word is used once the window has ended: a pass is
     * "expired" at that moment (a QR pass has no life of its own beyond the event's window), a manual entry is simply
     * "closed". Both stay refused for ever after, because the check is made on every request, not by a job.
     */
    assertEventAdmitting(event, now, qr) {
        if (event.status === Event_1.EventStatus.CANCELLED)
            throw new Error('EVENT_CANCELLED');
        if (event.status === Event_1.EventStatus.COMPLETED)
            throw new Error('EVENT_COMPLETED');
        if (event.status !== Event_1.EventStatus.PUBLISHED)
            throw new Error('EVENT_NOT_PUBLISHED');
        const window = (0, admissionWindow_1.effectiveAdmission)(event);
        if (!window)
            return; // an event without usable times is not time-gated
        const state = (0, admissionWindow_1.admissionState)(window, now);
        if (state === 'NOT_OPEN')
            throw new AdmissionError('ADMISSION_NOT_OPEN', window.opensAt, window.closesAt);
        if (state === 'CLOSED')
            throw new AdmissionError(qr ? 'CREDENTIAL_EXPIRED' : 'ADMISSION_CLOSED', window.opensAt, window.closesAt);
    },
    async getCheckIns(actor, eventId, options) {
        const { assignment } = await this.validateActorAndEvent(actor, eventId);
        const page = options.page && options.page > 0 ? options.page : 1;
        const limit = options.limit && options.limit > 0 ? options.limit : 20;
        const skip = (page - 1) * limit;
        let allowedSessionIds = undefined;
        if (actor.role === User_1.Role.SYSTEM_USER && assignment) {
            if (assignment.sessionIds && assignment.sessionIds.length > 0) {
                allowedSessionIds = assignment.sessionIds.map((id) => id.toString());
            }
        }
        if (options.sessionId) {
            if (actor.role === User_1.Role.SYSTEM_USER && allowedSessionIds && !allowedSessionIds.includes(options.sessionId)) {
                throw new Error('STAFF_SESSION_FORBIDDEN');
            }
        }
        const records = await checkIn_repository_1.checkInRepository.findEventCheckIns(eventId, {
            sessionId: options.sessionId,
            checkInMethod: options.checkInMethod,
            allowedSessionIds,
            skip,
            limit
        });
        const total = await checkIn_repository_1.checkInRepository.countEventCheckIns(eventId, {
            sessionId: options.sessionId,
            checkInMethod: options.checkInMethod,
            allowedSessionIds
        });
        const sanitizedRecords = records.map(record => {
            const invitee = record.inviteeId;
            const session = record.sessionId;
            const checkedInBy = record.checkedInBy;
            return {
                _id: record._id,
                eventId: record.eventId,
                checkInMethod: record.checkInMethod,
                checkInAt: record.checkInAt,
                invitee: invitee ? {
                    _id: invitee._id,
                    name: invitee.name,
                    email: invitee.email,
                    mobile: invitee.mobile,
                    dietaryPreference: invitee.dietaryPreference,
                    rsvpStatus: invitee.rsvpStatus
                } : null,
                session: session ? {
                    _id: session._id,
                    name: session.name,
                    schedule: session.schedule
                } : null,
                checkedInBy: checkedInBy ? {
                    _id: checkedInBy._id,
                    fullName: checkedInBy.fullName,
                    email: checkedInBy.email,
                    role: checkedInBy.role
                } : record.checkedInBy
            };
        });
        return {
            checkIns: sanitizedRecords,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        };
    },
    // Helper Methods
    async validateActorAndEvent(actor, eventId) {
        const event = await Event_1.Event.findById(eventId);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        let assignment = null;
        if (actor.role === User_1.Role.ADMIN) {
            return { event, assignment: null };
        }
        if (actor.role === User_1.Role.ORGANIZER) {
            if (event.organizerId.toString() !== actor.userId) {
                throw new Error('FORBIDDEN');
            }
            return { event, assignment: null };
        }
        if (actor.role === User_1.Role.SYSTEM_USER) {
            assignment = await SystemUserAssignment_1.SystemUserAssignment.findOne({ userId: actor.userId, eventId });
            if (!assignment) {
                throw new Error('STAFF_EVENT_FORBIDDEN');
            }
            return { event, assignment };
        }
        throw new Error('FORBIDDEN');
    },
    async validateStaffSessionAccess(actor, assignment, sessionId) {
        if (actor.role === User_1.Role.SYSTEM_USER && assignment) {
            if (assignment.sessionIds && assignment.sessionIds.length > 0) {
                const hasSession = assignment.sessionIds.some((id) => id.toString() === sessionId);
                if (!hasSession) {
                    throw new Error('STAFF_SESSION_FORBIDDEN');
                }
            }
        }
    },
    async validateInviteeEligibility(invitee, event) {
        if (event.rsvp && event.rsvp.enabled) {
            if (invitee.rsvpStatus === Invitee_1.RsvpStatus.DECLINED && !event.rsvp.allowDeclined) {
                throw new Error('RSVP_DECLINED');
            }
            if (invitee.rsvpStatus === Invitee_1.RsvpStatus.PENDING && !event.rsvp.allowNotResponded && !event.rsvp.allowAllInvited) {
                throw new Error('RSVP_PENDING');
            }
        }
    },
    async validateSessionAndRules(invitee, eventId, sessionId, now = clock_1.clock.now()) {
        const session = await Session_1.Session.findOne({ _id: sessionId, eventId });
        if (!session) {
            throw new Error('SESSION_NOT_FOUND');
        }
        // A session may carry its own admission window on top of the event's; without one, only the event's applies
        if (session.admission && (session.admission.opensAt || session.admission.closesAt)) {
            const own = (0, admissionWindow_1.effectiveAdmission)({ schedule: session.schedule, admission: session.admission });
            if (own) {
                const state = (0, admissionWindow_1.admissionState)(own, now);
                if (state === 'NOT_OPEN')
                    throw new AdmissionError('SESSION_NOT_OPEN', own.opensAt, own.closesAt);
                if (state === 'CLOSED')
                    throw new AdmissionError('SESSION_CLOSED', own.opensAt, own.closesAt);
            }
        }
        // Invitee session permissions (sessions that keep another session's invitees use that list)
        if (!(0, sessionAccess_1.inviteeAllowedInSession)(invitee, session)) {
            throw new Error('INVITEE_SESSION_DENIED');
        }
        // AccessControl (ONLY_ONCE / NO_RESTRICTION) check
        const existingSessionCheckIn = await checkIn_repository_1.checkInRepository.findByInviteeAndSession(invitee._id.toString(), sessionId);
        if (session.accessControl === Session_1.AccessControl.ONLY_ONCE && existingSessionCheckIn) {
            throw new Error('ONLY_ONCE_VIOLATION');
        }
        // NO_RESTRICTION: the same pass may be scanned again (every other rule above and below still applies). The repeat is
        // handled by the caller as a repeat entry on the existing attendance record, never as a second record.
        // "Consider access session validation on other session access" is configured on the primary
        // (first) session: when enabled, guests must have checked in to it before entering other sessions.
        const primary = await Session_1.Session.findOne({ eventId }).sort({ _id: 1 });
        if (primary && String(primary._id) !== String(session._id) && primary.validateAgainstOtherSessions) {
            const primaryCheckIn = await checkIn_repository_1.checkInRepository.findByInviteeAndSession(invitee._id.toString(), String(primary._id));
            if (!primaryCheckIn) {
                throw new Error('PRIMARY_SESSION_CHECKIN_REQUIRED');
            }
        }
        return Object.assign(session, { _existingCheckIn: existingSessionCheckIn });
    },
    /** NO_RESTRICTION repeat scan: count it on the existing record. Nothing new is admitted, so the event's admission counter is untouched. */
    async recordRepeatEntry(event, existing, invitee, session, now) {
        // narrow the window for a race with a cancel/close: a repeat entry is refused once the event has ended
        if (!(await Event_1.Event.exists({ _id: event._id, status: Event_1.EventStatus.PUBLISHED })))
            this.assertEventAdmitting(await Event_1.Event.findById(event._id), now, true);
        const updated = await CheckIn_1.CheckIn.findOneAndUpdate({ _id: existing._id }, { $inc: { scanCount: 1 }, $set: { lastScanAt: now } }, { new: true });
        return { ...this.formatCheckInResponse((updated || existing), invitee, session), reEntry: true, scanCount: updated?.scanCount ?? 2 };
    },
    formatCheckInResponse(checkIn, invitee, session) {
        return {
            _id: checkIn._id,
            eventId: checkIn.eventId,
            checkInMethod: checkIn.checkInMethod,
            checkInAt: checkIn.checkInAt,
            checkedInBy: checkIn.checkedInBy,
            invitee: {
                _id: invitee._id,
                name: invitee.name,
                email: invitee.email,
                mobile: invitee.mobile,
                dietaryPreference: invitee.dietaryPreference,
                rsvpStatus: invitee.rsvpStatus
            },
            session: session ? {
                _id: session._id,
                name: session.name,
                schedule: session.schedule
            } : null
        };
    }
};
