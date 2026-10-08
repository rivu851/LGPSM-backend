"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkInService = void 0;
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
/**
 * Core service for event check-in operations (QR scanning and manual entry).
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
        const { event, assignment } = await this.validateActorAndEvent(actor, eventId);
        if (dto.sessionId) {
            await this.validateStaffSessionAccess(actor, assignment, dto.sessionId);
        }
        await this.validateInviteeEligibility(invitee, event);
        let session = null;
        if (dto.sessionId) {
            session = await this.validateSessionAndRules(invitee, eventId, dto.sessionId);
        }
        // Check duplicate event-wide check-in if no sessionId
        if (!dto.sessionId) {
            const existing = await checkIn_repository_1.checkInRepository.findEventWideCheckIn(invitee._id.toString(), eventId);
            if (existing) {
                throw new Error('DUPLICATE_CHECKIN');
            }
        }
        const checkIn = await checkIn_repository_1.checkInRepository.create({
            eventId: new mongoose_1.default.Types.ObjectId(eventId),
            inviteeId: invitee._id,
            sessionId: dto.sessionId ? new mongoose_1.default.Types.ObjectId(dto.sessionId) : null,
            checkInMethod: CheckIn_1.CheckInMethod.QR,
            checkedInBy: new mongoose_1.default.Types.ObjectId(actor.userId),
            checkInAt: new Date()
        });
        return this.formatCheckInResponse(checkIn, invitee, session);
    },
    async manualCheckIn(actor, dto) {
        if (!dto.eventId) {
            throw new Error('EVENT_ID_REQUIRED');
        }
        const { event, assignment } = await this.validateActorAndEvent(actor, dto.eventId);
        if (dto.sessionId) {
            await this.validateStaffSessionAccess(actor, assignment, dto.sessionId);
        }
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
        await this.validateInviteeEligibility(invitee, event);
        let session = null;
        if (dto.sessionId) {
            session = await this.validateSessionAndRules(invitee, dto.eventId, dto.sessionId);
        }
        if (!dto.sessionId) {
            const existing = await checkIn_repository_1.checkInRepository.findEventWideCheckIn(invitee._id.toString(), dto.eventId);
            if (existing) {
                throw new Error('DUPLICATE_CHECKIN');
            }
        }
        const checkIn = await checkIn_repository_1.checkInRepository.create({
            eventId: new mongoose_1.default.Types.ObjectId(dto.eventId),
            inviteeId: invitee._id,
            sessionId: dto.sessionId ? new mongoose_1.default.Types.ObjectId(dto.sessionId) : null,
            checkInMethod: CheckIn_1.CheckInMethod.MANUAL,
            checkedInBy: new mongoose_1.default.Types.ObjectId(actor.userId),
            checkInAt: new Date()
        });
        return this.formatCheckInResponse(checkIn, invitee, session);
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
    async validateSessionAndRules(invitee, eventId, sessionId) {
        const session = await Session_1.Session.findOne({ _id: sessionId, eventId });
        if (!session) {
            throw new Error('SESSION_NOT_FOUND');
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
