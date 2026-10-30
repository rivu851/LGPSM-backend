"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanNote = exports.NOTE_MAX = exports.REASON_CATEGORIES = void 0;
exports.validateReason = validateReason;
exports.replacementAfterRevocation = replacementAfterRevocation;
exports.credentialStatus = credentialStatus;
exports.eligibleForAdmission = eligibleForAdmission;
const Invitee_1 = require("../models/Invitee");
const admissionWindow_1 = require("./admissionWindow");
// Access pass ("credential") rules. A guest's pass is separate from their invitation delivery and from their RSVP.
exports.REASON_CATEGORIES = [
    'LOST_OR_COMPROMISED',
    'FORWARDED_OR_SHARED',
    'DUPLICATE_OR_INCORRECT',
    'ACCESS_WITHDRAWN',
    'ATTENDEE_REQUESTED_REPLACEMENT',
    'OTHER'
];
exports.NOTE_MAX = 500;
/** Category is mandatory, the explanation optional - except for OTHER. "Access withdrawn" is never a reason to issue a new pass. */
function validateReason(action, category, note) {
    if (typeof category !== 'string' || !exports.REASON_CATEGORIES.includes(category))
        return 'Choose a reason.';
    if (action === 'REPLACE' && category === 'ACCESS_WITHDRAWN')
        return '"Access withdrawn" is not a reason to issue a new pass.';
    const text = typeof note === 'string' ? note.trim() : '';
    if (category === 'OTHER' && !text)
        return 'Explain the reason when you choose Other.';
    if (text.length > exports.NOTE_MAX)
        return `The explanation can be at most ${exports.NOTE_MAX} characters.`;
    return null;
}
const cleanNote = (note) => {
    const t = typeof note === 'string' ? note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, exports.NOTE_MAX) : '';
    return t || undefined;
};
exports.cleanNote = cleanNote;
/**
 * May a pass that was revoked for this reason be replaced through the ordinary Replace action?
 *  ALLOWED    lost/compromised, forwarded/shared, duplicate/incorrect, attendee-requested
 *  PROHIBITED access withdrawn
 *  REVIEW     other: needs an explicit review confirmation first
 */
function replacementAfterRevocation(category) {
    if (category === 'ACCESS_WITHDRAWN')
        return 'PROHIBITED';
    if (category === 'OTHER')
        return 'REVIEW';
    return 'ALLOWED';
}
/**
 * The status of the guest's CURRENT pass, derived on read. "Replaced" is deliberately not a value here: a replaced pass is
 * history (CredentialEvent), and a guest with a newer pass is Active.
 */
function credentialStatus(invitee, event, now = new Date()) {
    if (!invitee.qrTokenHash)
        return { status: 'NOT_ISSUED' };
    if (invitee.credentialRevokedAt)
        return { status: 'REVOKED' };
    if (event.status === 'CANCELLED')
        return { status: 'EXPIRED', reason: 'EVENT_CANCELLED' };
    if (event.status === 'COMPLETED')
        return { status: 'EXPIRED', reason: 'EVENT_COMPLETED' };
    const w = (0, admissionWindow_1.effectiveAdmission)(event);
    if (w && (0, admissionWindow_1.admissionState)(w, now) === 'CLOSED')
        return { status: 'EXPIRED', reason: 'ADMISSION_CLOSED' };
    return { status: 'ACTIVE' };
}
/** The same RSVP rules the door applies (checkIn.service.validateInviteeEligibility), so a replacement is never issued to someone who could not enter. */
function eligibleForAdmission(invitee, event) {
    if (event.rsvp && event.rsvp.enabled) {
        if (invitee.rsvpStatus === Invitee_1.RsvpStatus.DECLINED && !event.rsvp.allowDeclined)
            return false;
        if (invitee.rsvpStatus === Invitee_1.RsvpStatus.PENDING && !event.rsvp.allowNotResponded && !event.rsvp.allowAllInvited)
            return false;
    }
    return true;
}
