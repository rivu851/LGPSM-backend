import mongoose from 'mongoose';
import { Invitee } from '../models/Invitee';
import { EventStatus } from '../models/Event';
import { CredentialEvent } from '../models/CredentialEvent';
import { PassNotice } from '../models/PassNotice';
import { Role } from '../models/User';
import { findManageableEvent } from '../utils/eventAccess';
import { generateSecureToken, hashToken } from '../utils/invitation.util';
import { encryptToken } from '../utils/tokenCipher';
import { cleanNote, credentialStatus, eligibleForAdmission, replacementAfterRevocation, validateReason } from '../utils/credentialPolicy';
import { planRecipients } from './cancellationNotice.service';

// Individual access passes: revoke, replace, and the history of both.
//
// Rules (product-owner decisions):
//  * Revoke and Replace are for the event's owner or an admin, on a PUBLISHED event. A reason category is mandatory.
//  * Replace always notifies the guest, on the channels their invitation previously succeeded on; there is no silent option.
//  * Replace is atomic: the new pass is prepared first, then the old one is swapped out in ONE conditional step (inside a
//    transaction where the database supports it). If anything fails before the swap, the old pass stays valid.
//  * The history is append-only: a revocation keeps its reason after the pass is replaced; the replacement is an additional event.
//  * RSVP is never touched.

type Actor = { userId: string; role: string };

const err = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(code), extra);

let txSupport: Promise<boolean> | undefined;
function supportsTransactions(): Promise<boolean> {
  txSupport ??= (async () => {
    try {
      const hello: any = await mongoose.connection.db!.admin().command({ hello: 1 });
      return !!(hello.setName || hello.msg === 'isdbgrid');
    } catch {
      return false;
    }
  })();
  return txSupport;
}

async function loadForAction(actor: Actor, inviteeId: string) {
  if (actor.role !== Role.ADMIN && actor.role !== Role.ORGANIZER) throw err('FORBIDDEN');
  if (!mongoose.Types.ObjectId.isValid(inviteeId)) throw err('INVITEE_NOT_FOUND');
  const invitee: any = await Invitee.findById(inviteeId).select('+qrTokenCipher');
  if (!invitee) throw err('INVITEE_NOT_FOUND');
  const event: any = await findManageableEvent(String(invitee.eventId), actor.userId, actor.role);
  if (!event) throw err('INVITEE_NOT_FOUND');
  return { invitee, event };
}

export const credentialService = {
  /** Called by send / resend after a pass was delivered: keeps the version counter and the history complete. Never throws into the send. */
  async recordIssuance(args: { invitee: any; tokenHash: string; source: 'SEND' | 'RESEND'; actorId: string; actorRole: string; organizerId: any }) {
    const { invitee, tokenHash, source } = args;
    const had = !!(invitee.credentialVersion || (await CredentialEvent.exists({ inviteeId: invitee._id })));
    const version = had ? (invitee.credentialVersion || 1) + 1 : 1;
    await Invitee.updateOne({ _id: invitee._id }, { $set: { credentialVersion: version } });
    invitee.credentialVersion = version;
    await CredentialEvent.create({
      eventId: invitee.eventId, inviteeId: invitee._id, organizerId: args.organizerId,
      type: had ? 'REPLACED' : 'ISSUED', version, previousVersion: had ? version - 1 : undefined, source,
      actorId: mongoose.Types.ObjectId.isValid(args.actorId) ? args.actorId : undefined, actorRole: args.actorRole, tokenHash
    });
  },

  async revoke(actor: Actor, inviteeId: string, input: { category?: unknown; note?: unknown }) {
    const problem = validateReason('REVOKE', input.category, input.note);
    if (problem) throw err('INVALID_REASON', { detail: problem });
    const { invitee, event } = await loadForAction(actor, inviteeId);
    if (event.status !== EventStatus.PUBLISHED) throw err('EVENT_NOT_ACTIVE');
    const current = credentialStatus(invitee, event);
    if (current.status === 'NOT_ISSUED') throw err('NOT_ISSUED');
    if (invitee.credentialRevokedAt) return { alreadyRevoked: true, invitee };

    const now = new Date();
    const note = cleanNote(input.note);
    const category = input.category as string;
    // conditional: two revokes at once produce one revocation and one notice
    const updated: any = await Invitee.findOneAndUpdate(
      { _id: invitee._id, credentialRevokedAt: null },
      { $set: { credentialRevokedAt: now, credentialRevocation: { category, note, by: new mongoose.Types.ObjectId(actor.userId), at: now } } },
      { new: true }
    );
    if (!updated) return { alreadyRevoked: true, invitee };
    const version = invitee.credentialVersion || 1;
    const credentialEvent = await CredentialEvent.create({
      eventId: invitee.eventId, inviteeId: invitee._id, organizerId: event.organizerId, type: 'REVOKED', version, source: 'REVOKE',
      reasonCategory: category, note, actorId: actor.userId, actorRole: actor.role, tokenHash: invitee.qrTokenHash
    });
    const notice = await this.queueNotice(event, updated, credentialEvent, 'REVOKED');
    return { alreadyRevoked: false, invitee: updated, credentialEvent, notice };
  },

  async replace(actor: Actor, inviteeId: string, input: { category?: unknown; note?: unknown; reviewConfirmed?: unknown }) {
    const problem = validateReason('REPLACE', input.category, input.note);
    if (problem) throw err('INVALID_REASON', { detail: problem });
    const { invitee, event } = await loadForAction(actor, inviteeId);
    if (event.status !== EventStatus.PUBLISHED) throw err('EVENT_NOT_ACTIVE');
    const current = credentialStatus(invitee, event);
    if (current.status === 'NOT_ISSUED') throw err('NOT_ISSUED');
    if (current.status === 'EXPIRED') throw err('CREDENTIAL_EXPIRED');

    let reviewConfirmed = false;
    if (current.status === 'REVOKED') {
      const rule = replacementAfterRevocation(invitee.credentialRevocation?.category);
      if (rule === 'PROHIBITED') throw err('REPLACEMENT_NOT_ALLOWED');
      if (rule === 'REVIEW') {
        if (input.reviewConfirmed !== true) throw err('REVIEW_REQUIRED');
        reviewConfirmed = true;
      }
      if (!eligibleForAdmission(invitee, event)) throw err('NOT_ELIGIBLE');
    }

    // The guest must be reachable the way they were invited: a replacement is never silent
    const plan = (await planRecipients(event._id, invitee._id)).find((p) => String(p.inviteeId) === String(invitee._id));
    if (!plan || (!plan.email && !plan.whatsapp)) throw err('NO_DELIVERY_CHANNEL');

    // 1. Prepare everything that can fail, without touching the guest's current pass
    const rawToken = generateSecureToken();
    const newHash = hashToken(rawToken);
    const cipher = encryptToken(rawToken);
    try {
      const { invitationService } = await import('./invitation.service');
      await invitationService.renderPassCard(event, { ...invitee.toObject(), _id: invitee._id }, rawToken);
    } catch (e: any) {
      throw err('CARD_RENDER_FAILED', { detail: e?.message });
    }

    // 2. Swap: one conditional update (the old hash must still be the current one), plus the history and the notice
    const previousHash = invitee.qrTokenHash;
    const previousVersion = invitee.credentialVersion || 1;
    const version = previousVersion + 1;
    const note = cleanNote(input.note);
    const category = input.category as string;
    const doSwap = async (session?: mongoose.ClientSession) => {
      const swapped: any = await Invitee.findOneAndUpdate(
        { _id: invitee._id, qrTokenHash: previousHash },
        { $set: { qrTokenHash: newHash, qrTokenCipher: cipher, credentialRevokedAt: null, credentialRevocation: null, credentialVersion: version } },
        { new: true, session }
      );
      if (!swapped) throw err('CONFLICT');
      const [credentialEvent] = await CredentialEvent.create([{
        eventId: invitee.eventId, inviteeId: invitee._id, organizerId: event.organizerId, type: 'REPLACED', version, previousVersion, source: 'REPLACE',
        reasonCategory: category, note, actorId: actor.userId, actorRole: actor.role, reviewConfirmed: reviewConfirmed || undefined, tokenHash: newHash
      }], { session });
      const notice = await this.queueNotice(event, swapped, credentialEvent, 'REPLACED', session);
      return { swapped, credentialEvent, notice };
    };

    let result: Awaited<ReturnType<typeof doSwap>>;
    if (await supportsTransactions()) {
      const session = await mongoose.startSession();
      try {
        let r: any;
        await session.withTransaction(async () => { r = await doSwap(session); });
        result = r;
      } finally {
        await session.endSession();
      }
    } else {
      // No transactions (standalone database): swap first, and undo it if the history/notice cannot be written
      const swapped: any = await Invitee.findOneAndUpdate(
        { _id: invitee._id, qrTokenHash: previousHash },
        { $set: { qrTokenHash: newHash, qrTokenCipher: cipher, credentialRevokedAt: null, credentialRevocation: null, credentialVersion: version } },
        { new: true }
      );
      if (!swapped) throw err('CONFLICT');
      try {
        const credentialEvent = await CredentialEvent.create({
          eventId: invitee.eventId, inviteeId: invitee._id, organizerId: event.organizerId, type: 'REPLACED', version, previousVersion, source: 'REPLACE',
          reasonCategory: category, note, actorId: actor.userId, actorRole: actor.role, reviewConfirmed: reviewConfirmed || undefined, tokenHash: newHash
        });
        const notice = await this.queueNotice(event, swapped, credentialEvent, 'REPLACED');
        result = { swapped, credentialEvent, notice };
      } catch (e) {
        await Invitee.updateOne(
          { _id: invitee._id, qrTokenHash: newHash },
          { $set: { qrTokenHash: previousHash, qrTokenCipher: invitee.qrTokenCipher, credentialRevokedAt: invitee.credentialRevokedAt ?? null, credentialRevocation: invitee.credentialRevocation ?? null, credentialVersion: previousVersion } }
        );
        await CredentialEvent.deleteMany({ inviteeId: invitee._id, tokenHash: newHash }).catch(() => undefined);
        throw e;
      }
    }
    const { notificationsStarted } = await this.startNotices(result.notice);
    return { invitee: result.swapped, credentialEvent: result.credentialEvent, notice: result.notice, notificationsStarted };
  },

  /** Stores the notice for a credential change (inside the same transaction as the change when one is open). */
  async queueNotice(event: any, invitee: any, credentialEvent: any, kind: 'REPLACED' | 'REVOKED', session?: mongoose.ClientSession) {
    const plan = (await planRecipients(event._id, invitee._id)).find((p) => String(p.inviteeId) === String(invitee._id));
    const use = (on: boolean | undefined) => (on ? { status: 'PENDING', attempts: 0 } : { status: 'NOT_USED', attempts: 0 });
    const noChannel = !plan || (!plan.email && !plan.whatsapp);
    const [doc] = await PassNotice.create([{
      eventId: event._id, inviteeId: invitee._id, organizerId: event.organizerId, credentialEventId: credentialEvent._id, kind,
      credentialVersion: credentialEvent.version,
      // a guest who was never reachable is reported, not silently skipped
      email: noChannel ? { status: 'UNAVAILABLE', attempts: 0, failureReason: 'No earlier invitation reached this guest on any channel' } : use(plan?.email),
      whatsapp: use(plan?.whatsapp)
    }], { session });
    return doc;
  },

  async startNotices(notice: any) {
    const { passNoticeService } = await import('./passNotice.service');
    passNoticeService.processNotice(notice._id).catch((e: any) => console.error('Pass notice dispatch failed:', e?.message));
    return { notificationsStarted: true };
  },

  /** The guest's pass history, newest last, with each change's notice outcome. No tokens. */
  async history(actor: Actor, eventId: string, opts: { inviteeId?: string; limit?: number } = {}) {
    if (actor.role !== Role.ADMIN && actor.role !== Role.ORGANIZER) throw err('FORBIDDEN');
    const event: any = await findManageableEvent(eventId, actor.userId, actor.role);
    if (!event) throw err('EVENT_NOT_FOUND');
    const filter: any = { eventId: event._id };
    if (opts.inviteeId && mongoose.Types.ObjectId.isValid(opts.inviteeId)) filter.inviteeId = opts.inviteeId;
    const events: any[] = await CredentialEvent.find(filter).sort({ createdAt: -1 }).limit(Math.min(opts.limit || 100, 200)).lean();
    const notices: any[] = await PassNotice.find({ credentialEventId: { $in: events.map((e) => e._id) } }).lean();
    const byEvent = new Map(notices.map((n) => [String(n.credentialEventId), n]));
    const invitees: any[] = await Invitee.find({ _id: { $in: events.map((e) => e.inviteeId) } }).select('name').lean();
    const names = new Map(invitees.map((i) => [String(i._id), i.name]));
    const Users = (await import('../models/User')).User;
    const actors: any[] = await Users.find({ _id: { $in: events.map((e) => e.actorId).filter(Boolean) } }).select('fullName').lean();
    const actorNames = new Map(actors.map((a) => [String(a._id), a.fullName]));
    return events.map((e) => {
      const n = byEvent.get(String(e._id));
      return {
        _id: e._id, inviteeId: e.inviteeId, inviteeName: names.get(String(e.inviteeId)) || 'Guest', type: e.type, version: e.version, previousVersion: e.previousVersion,
        source: e.source, reasonCategory: e.reasonCategory, note: e.note, reviewConfirmed: !!e.reviewConfirmed, actor: e.actorId ? actorNames.get(String(e.actorId)) || e.actorRole : undefined, at: e.createdAt,
        // historical state of the pass this row is about: a replaced pass is "Replaced" (a revoked-then-replaced one keeps its Revoked row)
        notice: n ? { kind: n.kind, email: n.email, whatsapp: n.whatsapp } : undefined
      };
    });
  }
};

export type CredentialErrorCode =
  | 'FORBIDDEN' | 'INVITEE_NOT_FOUND' | 'INVALID_REASON' | 'EVENT_NOT_ACTIVE' | 'NOT_ISSUED' | 'CREDENTIAL_EXPIRED'
  | 'REPLACEMENT_NOT_ALLOWED' | 'REVIEW_REQUIRED' | 'NOT_ELIGIBLE' | 'NO_DELIVERY_CHANNEL' | 'CARD_RENDER_FAILED' | 'CONFLICT' | 'EVENT_NOT_FOUND';

