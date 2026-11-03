"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLAIM_MAX_AGE_MS = void 0;
exports.claimInviteeForIssue = claimInviteeForIssue;
exports.releaseInviteeClaim = releaseInviteeClaim;
const Invitee_1 = require("../models/Invitee");
// Anything that mints a new admission credential for a guest (send, re-send, replace) holds this claim while it works. It lives on
// the guest's record, so it holds across backend instances. Two overlapping issues would otherwise deliver two passes of which only
// the last one saved works. A claim older than the limit was left by a process that died mid-send and is taken over.
exports.CLAIM_MAX_AGE_MS = 10 * 60 * 1000;
async function claimInviteeForIssue(inviteeId) {
    const now = new Date();
    const stale = new Date(now.getTime() - exports.CLAIM_MAX_AGE_MS);
    const res = await Invitee_1.Invitee.updateOne({ _id: inviteeId, $or: [{ sendClaimAt: null }, { sendClaimAt: { $lt: stale } }] }, { $set: { sendClaimAt: now } }, { timestamps: false });
    return res.modifiedCount === 1;
}
async function releaseInviteeClaim(inviteeId) {
    await Invitee_1.Invitee.updateOne({ _id: inviteeId }, { $unset: { sendClaimAt: '' } }, { timestamps: false });
}
