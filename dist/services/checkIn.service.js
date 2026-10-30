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
            const superseded = await Invitation_1.Invitation.exists({ tokenHash });
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
        }
        else {
            const existing = await checkIn_repository_1.checkInRepository.findEventWideCheckIn(invitee._id.toString(), eventId);
            if (existing) {
                throw new Error('DUPLICATE_CHECKIN');
            }
        }
        // A duplicate key (11000) from a concurrent scan surfaces as "already checked in" in the controller
        const checkIn = await checkIn_repository_1.checkInRepository.create({
            eventId: new mongoose_1.default.Types.ObjectId(eventId),
            inviteeId: invitee._id,
            sessionId: sessionId ? new mongoose_1.default.Types.ObjectId(sessionId) : null,
            checkInMethod: method,
            checkedInBy: new mongoose_1.default.Types.ObjectId(actor.userId),
            checkInAt: now
        });
        return this.formatCheckInResponse(checkIn, invitee, session);
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
        if (session.accessControl === Session_1.AccessControl.NO_RESTRICTION && existingSessionCheckIn) {
            throw new Error('DUPLICATE_CHECKIN');
        }
        // "Consider access session validation on other session access" is configured on the primary
        // (first) session: when enabled, guests must have checked in to it before entering other sessions.
        const primary = await Session_1.Session.findOne({ eventId }).sort({ _id: 1 });
        if (primary && String(primary._id) !== String(session._id) && primary.validateAgainstOtherSessions) {
            const primaryCheckIn = await checkIn_repository_1.checkInRepository.findByInviteeAndSession(invitee._id.toString(), String(primary._id));
            if (!primaryCheckIn) {
                throw new Error('PRIMARY_SESSION_CHECKIN_REQUIRED');
            }
        }
        return session;
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
