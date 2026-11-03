import mongoose from 'mongoose';
import { Invitee } from '../models/Invitee';

// Anything that mints a new admission credential for a guest (send, re-send, replace) holds this claim while it works. It lives on
// the guest's record, so it holds across backend instances. Two overlapping issues would otherwise deliver two passes of which only
// the last one saved works. A claim older than the limit was left by a process that died mid-send and is taken over.
export const CLAIM_MAX_AGE_MS = 10 * 60 * 1000;

export async function claimInviteeForIssue(inviteeId: unknown): Promise<boolean> {
  const now = new Date();
  const stale = new Date(now.getTime() - CLAIM_MAX_AGE_MS);
  const res = await Invitee.updateOne(
    { _id: inviteeId as mongoose.Types.ObjectId, $or: [{ sendClaimAt: null }, { sendClaimAt: { $lt: stale } }] },
    { $set: { sendClaimAt: now } },
    { timestamps: false }
  );
  return res.modifiedCount === 1;
}

export async function releaseInviteeClaim(inviteeId: unknown): Promise<void> {
  await Invitee.updateOne({ _id: inviteeId as mongoose.Types.ObjectId }, { $unset: { sendClaimAt: '' } }, { timestamps: false });
}
