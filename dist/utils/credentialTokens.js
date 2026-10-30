"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invitationLookup = void 0;
exports.readInvitationToken = readInvitationToken;
exports.readAdmissionToken = readAdmissionToken;
exports.planInvitationToken = planInvitationToken;
const invitation_util_1 = require("./invitation.util");
const tokenCipher_1 = require("./tokenCipher");
/** Mongo filter that finds a guest by the token in their invitation link. */
const invitationLookup = (hash) => ({
    $or: [{ invitationTokenHash: hash }, { invitationTokenHash: { $exists: false }, qrTokenHash: hash }]
});
exports.invitationLookup = invitationLookup;
/** The raw invitation token, when it can be recovered (needs the ciphers to have been selected). */
function readInvitationToken(g) {
    if (g.invitationTokenHash) {
        const t = (0, tokenCipher_1.decryptToken)(g.invitationTokenCipher || undefined);
        return t && (0, invitation_util_1.hashToken)(t) === g.invitationTokenHash ? t : null;
    }
    const t = (0, tokenCipher_1.decryptToken)(g.qrTokenCipher || undefined); // pre-separation guest: the one shared token
    return t && g.qrTokenHash && (0, invitation_util_1.hashToken)(t) === g.qrTokenHash ? t : null;
}
/** The raw ADMISSION credential currently held by the guest, or null. */
function readAdmissionToken(g) {
    const t = (0, tokenCipher_1.decryptToken)(g.qrTokenCipher || undefined);
    return t && g.qrTokenHash && (0, invitation_util_1.hashToken)(t) === g.qrTokenHash ? t : null;
}
/** The invitation token to put in links: the guest's existing one (adopting a pre-separation shared token), or a new one. */
function planInvitationToken(g) {
    const existing = readInvitationToken(g);
    if (existing)
        return { raw: existing, hash: (0, invitation_util_1.hashToken)(existing), cipher: g.invitationTokenHash ? g.invitationTokenCipher : (0, tokenCipher_1.encryptToken)(existing), persist: !g.invitationTokenHash };
    const raw = (0, invitation_util_1.generateSecureToken)();
    return { raw, hash: (0, invitation_util_1.hashToken)(raw), cipher: (0, tokenCipher_1.encryptToken)(raw), persist: true };
}
