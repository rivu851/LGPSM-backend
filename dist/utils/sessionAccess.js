"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accessSessionIdFor = accessSessionIdFor;
exports.inviteeAllowedInSession = inviteeAllowedInSession;
exports.inviteesAllowedFilter = inviteesAllowedFilter;
const Session_1 = require("../models/Session");
// A session that keeps the same invitees as another session ("COPY_SESSION") has no invitee list of
// its own: access is decided by the source session's list.
function accessSessionIdFor(session) {
    if (session.inviteeSource === Session_1.InviteeSource.COPY_SESSION && session.sourceSessionId) {
        return String(session.sourceSessionId);
    }
    return String(session._id);
}
// Invitees without explicit session rules may attend every session
function inviteeAllowedInSession(invitee, session) {
    if (!invitee.sessionAccess || invitee.sessionAccess.length === 0)
        return true;
    const target = accessSessionIdFor(session);
    const entry = invitee.sessionAccess.find((sa) => String(sa.sessionId) === target);
    return !!entry && entry.allowed !== false;
}
// MongoDB filter for invitees allowed into a session (used for counts)
function inviteesAllowedFilter(session) {
    const target = accessSessionIdFor(session);
    return {
        $or: [
            { sessionAccess: { $size: 0 } },
            { sessionAccess: { $elemMatch: { sessionId: target, allowed: true } } }
        ]
    };
}
