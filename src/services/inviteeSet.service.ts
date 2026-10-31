import mongoose from 'mongoose';
import { Invitee, IInvitee, InvitationStatus, RsvpStatus } from '../models/Invitee';
import { InviteeSet } from '../models/InviteeSet';
import { Invitation, InvitationDeliveryStatus } from '../models/Invitation';
import { CheckIn } from '../models/CheckIn';
import { CredentialEvent } from '../models/CredentialEvent';
import { Event, EventStatus } from '../models/Event';
import { User, Role } from '../models/User';
import { auditLogService } from './auditLog.service';
import { whatsappService } from './whatsapp.service';

// Guests without a tracked list (added by hand, or before lists were tracked) are treated as one "earlier" list.
export const LEGACY_SET = 'legacy';
export const ALL_SETS = 'all';
export const setKeyOf = (inv: Pick<IInvitee, 'inviteeSetId'>): string => (inv.inviteeSetId ? String(inv.inviteeSetId) : LEGACY_SET);

export type DeliveryState = 'NOT_SENT' | 'SENT' | 'FAILED' | 'UNKNOWN';

/** What has happened to one guest, from every record that can say so (the guest row alone is not enough). */
export interface GuestActivity {
  /** An invitation was successfully dispatched (provider accepted) */
  sent: boolean;
  /** Attempted, never confirmed sent, and every attempt failed */
  failed: boolean;
  /** An attempt exists whose outcome was never settled (unfinished delivery record): not "failed", not "never invited" */
  unknown: boolean;
  /** Any invitation attempt or access pass exists at all */
  attempted: boolean;
  rsvp: boolean;
  checkedIn: boolean;
}

export const deliveryStateOf = (a: GuestActivity): DeliveryState => (a.sent ? 'SENT' : a.unknown ? 'UNKNOWN' : a.failed ? 'FAILED' : 'NOT_SENT');

/** Only a guest nothing has ever happened to can be set aside. */
export const neverAttempted = (a: GuestActivity): boolean => !a.attempted && !a.rsvp && !a.checkedIn;

export async function loadActivity(eventId: unknown, invitees: IInvitee[]): Promise<Map<string, GuestActivity>> {
  const eid = new mongoose.Types.ObjectId(String(eventId));
  const [invitations, checked, credentialed] = await Promise.all([
    Invitation.find({ eventId: eid }).select('inviteeId status').lean(),
    CheckIn.distinct('inviteeId', { eventId: eid }),
    CredentialEvent.distinct('inviteeId', { eventId: eid })
  ]);
  const byInvitee = new Map<string, string[]>();
  for (const row of invitations as any[]) {
    const k = String(row.inviteeId);
    byInvitee.set(k, [...(byInvitee.get(k) || []), row.status]);
  }
  const checkedIn = new Set(checked.map(String));
  const hasCredential = new Set(credentialed.map(String));
  const out = new Map<string, GuestActivity>();
  for (const inv of invitees) {
    const id = String(inv._id);
    const rows = byInvitee.get(id) || [];
    const sent = inv.invitationStatus === InvitationStatus.SENT || rows.includes(InvitationDeliveryStatus.SENT);
    const unknown = !sent && rows.includes(InvitationDeliveryStatus.PENDING);
    const failed = !sent && !unknown && (inv.invitationStatus === InvitationStatus.FAILED || rows.includes(InvitationDeliveryStatus.FAILED));
    out.set(id, {
      sent, failed, unknown,
      attempted: sent || failed || unknown || rows.length > 0 || !!inv.qrTokenHash || hasCredential.has(id),
      rsvp: inv.rsvpStatus !== RsvpStatus.PENDING,
      checkedIn: checkedIn.has(id)
    });
  }
  return out;
}

/** The authoritative lock state, from the server's records: a successful dispatch, an RSVP, or a check-in locks a list. */
export function lockReasonsBySet(invitees: IInvitee[], activity: Map<string, GuestActivity>): Map<string, { sent: number; rsvp: number; checkedIn: number }> {
  const out = new Map<string, { sent: number; rsvp: number; checkedIn: number }>();
  for (const inv of invitees) {
    const a = activity.get(String(inv._id));
    if (!a || !(a.sent || a.rsvp || a.checkedIn)) continue;
    const k = setKeyOf(inv);
    const r = out.get(k) || { sent: 0, rsvp: 0, checkedIn: 0 };
    if (a.sent) r.sent++;
    if (a.rsvp) r.rsvp++;
    if (a.checkedIn) r.checkedIn++;
    out.set(k, r);
  }
  return out;
}

export const lockedSetKeys = (invitees: IInvitee[], activity: Map<string, GuestActivity>): Set<string> => new Set(lockReasonsBySet(invitees, activity).keys());

// Import and restore both read "who is on the list" and then write; running them one at a time per event stops a restore
// and an upload from creating the same person twice. (In-process: a single backend instance; see docs for the limit.)
const chains = new Map<string, Promise<unknown>>();
export function withEventLock<T>(eventId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(eventId) || Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  chains.set(eventId, tail);
  tail.then(() => { if (chains.get(eventId) === tail) chains.delete(eventId); });
  return run;
}

const mobileKey = (m?: string) => whatsappService.normalizePhoneNumber(m);
const fail = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code, message });

type Actor = { userId: string; role: string };

/** Owner organizer or admin only. System Users (and anyone else) are refused here as well as at the route. */
async function manageableEvent(actor: Actor, eventId: string) {
  if (!mongoose.Types.ObjectId.isValid(eventId)) throw fail(400, 'Invalid event id');
  if (actor.role !== Role.ADMIN && actor.role !== Role.ORGANIZER) throw fail(403, 'Not permitted to manage invitee lists');
  const event: any = actor.role === Role.ADMIN ? await Event.findById(eventId) : await Event.findOne({ _id: eventId, organizerId: actor.userId });
  if (!event) throw fail(404, 'Event not found or inaccessible');
  return event;
}

const nameMap = async (ids: unknown[]) => {
  const valid = [...new Set(ids.filter(Boolean).map(String))].filter((i) => mongoose.Types.ObjectId.isValid(i));
  const users = valid.length ? await User.find({ _id: { $in: valid } }).select('fullName role').lean() : [];
  return new Map((users as any[]).map((u) => [String(u._id), { id: String(u._id), name: u.fullName as string, role: u.role as string }]));
};

const REASON_TEXT: Record<string, string> = { SUPERSEDED_BY_UPLOAD: 'Replaced by a newer upload' };

export const inviteeSetService = {
  async list(actor: Actor, eventId: string) {
    await manageableEvent(actor, eventId);
    const eid = new mongoose.Types.ObjectId(eventId);
    const [invitees, sets] = await Promise.all([
      Invitee.find({ eventId: eid }).select('inviteeSetId invitationStatus rsvpStatus qrTokenHash createdAt').lean<IInvitee[]>(),
      InviteeSet.find({ eventId: eid }).sort({ createdAt: 1 }).lean()
    ]);
    const activity = await loadActivity(eid, invitees);
    const reasons = lockReasonsBySet(invitees, activity);
    // when invitations from each list went out: the first and the latest successful hand-off
    const setOf = new Map(invitees.map((i) => [String(i._id), setKeyOf(i)]));
    const sentRows = await Invitation.find({ eventId: eid, status: InvitationDeliveryStatus.SENT }).select('inviteeId sentAt createdAt').lean();
    const sentSpan = new Map<string, { first: Date; last: Date }>();
    for (const row of sentRows as any[]) {
      const k = setOf.get(String(row.inviteeId));
      const at: Date | undefined = row.sentAt || row.createdAt;
      if (!k || !at) continue;
      const cur = sentSpan.get(k);
      sentSpan.set(k, cur ? { first: at < cur.first ? at : cur.first, last: at > cur.last ? at : cur.last } : { first: at, last: at });
    }
    const aside = await Invitee.aggregate([{ $match: { eventId: eid, archivedAt: { $ne: null } } }, { $group: { _id: { $ifNull: ['$inviteeSetId', LEGACY_SET] }, n: { $sum: 1 } } }]).option({ includeArchived: true } as any);
    const asideBySet = new Map<string, number>(aside.map((r: any) => [String(r._id), r.n]));
    const rows = new Map<string, { total: number; sent: number; notSent: number; failed: number; unknown: number; rsvp: number; checkedIn: number }>();
    for (const inv of invitees) {
      const k = setKeyOf(inv);
      const r = rows.get(k) || { total: 0, sent: 0, notSent: 0, failed: 0, unknown: 0, rsvp: 0, checkedIn: 0 };
      const a = activity.get(String(inv._id))!;
      r.total++;
      const state = deliveryStateOf(a);
      if (state === 'SENT') r.sent++; else if (state === 'UNKNOWN') r.unknown++; else if (state === 'FAILED') r.failed++; else r.notSent++;
      if (a.rsvp) r.rsvp++;
      if (a.checkedIn) r.checkedIn++;
      rows.set(k, r);
    }
    const people = await nameMap(sets.map((s: any) => s.createdBy));
    const shape = (id: string, base: Record<string, unknown>) => {
      const r = rows.get(id) || { total: 0, sent: 0, notSent: 0, failed: 0, unknown: 0, rsvp: 0, checkedIn: 0 };
      const why = reasons.get(id);
      const locked = !!why;
      return {
        id, ...base, ...r, unsent: r.notSent, setAside: asideBySet.get(id) || 0, locked,
        // why the list is in this state (empty when Open)
        lockReasons: why ? { sentGuests: why.sent, answeredRsvp: why.rsvp, checkedIn: why.checkedIn } : null,
        // guests a Replace could still set aside: never attempted, and only in an Open list
        replaceableGuests: locked ? 0 : r.notSent,
        firstSentAt: sentSpan.get(id)?.first ?? null,
        lastSentAt: sentSpan.get(id)?.last ?? null
      };
    };
    const out: any[] = (sets as any[]).map((s) => shape(String(s._id), {
      name: s.name, source: 'EXCEL', mode: s.mode, sessionId: s.sessionId ? String(s.sessionId) : null, createdAt: s.createdAt,
      uploadedBy: s.createdBy ? people.get(String(s.createdBy)) || null : null, importedCount: s.importedCount ?? null
    }));
    // guests added by hand have no file: show when the first of them was added
    const legacyTimes = invitees.filter((i) => setKeyOf(i) === LEGACY_SET && (i as any).createdAt).map((i) => new Date((i as any).createdAt).getTime());
    const legacyAddedAt = legacyTimes.length ? new Date(Math.min(...legacyTimes)) : null;
    if (rows.has(LEGACY_SET) || asideBySet.has(LEGACY_SET)) {
      out.unshift(shape(LEGACY_SET, { name: 'Earlier invitees', source: 'MANUAL', mode: 'APPEND', sessionId: null, createdAt: legacyAddedAt, uploadedBy: null, importedCount: null }));
    }
    const archivedCount = [...asideBySet.values()].reduce((a, b) => a + b, 0);
    return { sets: out, archivedCount, hasSent: out.some((s) => s.locked) };
  },

  /** The guests currently in one list, with each guest's delivery state. No tokens, no credentials. */
  async members(actor: Actor, eventId: string, setId: string, page = 1, limit = 50, q = '') {
    await manageableEvent(actor, eventId);
    if (setId !== LEGACY_SET && setId !== ALL_SETS && !mongoose.Types.ObjectId.isValid(setId)) throw fail(400, 'Invalid list id');
    const eid = new mongoose.Types.ObjectId(eventId);
    const filter: any = { eventId: eid };
    if (setId !== ALL_SETS) filter.inviteeSetId = setId === LEGACY_SET ? null : new mongoose.Types.ObjectId(setId);
    const term = q.trim().slice(0, 100);
    if (term) {
      const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { mobile: rx }, { companyName: rx }, { company: rx }];
    }
    const lim = Math.min(Math.max(limit, 1), 100);
    const [guests, total] = await Promise.all([
      Invitee.find(filter).select('name email mobile companyName company invitationStatus rsvpStatus qrTokenHash inviteeSetId').sort({ name: 1 }).skip((Math.max(page, 1) - 1) * lim).limit(lim).lean<IInvitee[]>(),
      Invitee.countDocuments(filter)
    ]);
    const activity = await loadActivity(eid, guests);
    return {
      total, page, limit: lim,
      members: guests.map((g) => {
        const a = activity.get(String(g._id))!;
        return { id: String(g._id), name: g.name, email: g.email || null, mobile: g.mobile || null, company: g.companyName || g.company || null, delivery: deliveryStateOf(a), rsvpStatus: g.rsvpStatus, checkedIn: a.checkedIn };
      })
    };
  },

  /** Set-aside guests of one event, apart from the active list. Owner organizer and admin only. */
  async setAside(actor: Actor, eventId: string, opts: { q?: string; page?: number; limit?: number } = {}) {
    const event = await manageableEvent(actor, eventId);
    const eid = new mongoose.Types.ObjectId(eventId);
    const filter: any = { eventId: eid, archivedAt: { $ne: null } };
    if (opts.q?.trim()) {
      const rx = new RegExp(opts.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { mobile: rx }];
    }
    const page = Math.max(opts.page || 1, 1), limit = Math.min(Math.max(opts.limit || 50, 1), 100);
    const [guests, total] = await Promise.all([
      Invitee.find(filter).setOptions({ includeArchived: true } as any).select('name email mobile inviteeSetId archivedAt archivedReason supersededBySetId archivedBy archivedByRole').sort({ archivedAt: -1 }).skip((page - 1) * limit).limit(limit).lean<IInvitee[]>(),
      Invitee.countDocuments(filter).setOptions({ includeArchived: true } as any)
    ]);
    const setIds = [...new Set(guests.flatMap((g) => [g.inviteeSetId, g.supersededBySetId]).filter(Boolean).map(String))];
    const sets = setIds.length ? await InviteeSet.find({ _id: { $in: setIds } }).select('name').lean() : [];
    const setName = new Map((sets as any[]).map((s) => [String(s._id), s.name as string]));
    const people = await nameMap(guests.map((g) => g.archivedBy));
    return {
      restorable: restoreBlock(event) === null,
      notRestorableReason: restoreBlock(event),
      total, page, limit,
      guests: guests.map((g) => ({
        id: String(g._id), name: g.name, email: g.email || null, mobile: g.mobile || null,
        fromSet: { id: g.inviteeSetId ? String(g.inviteeSetId) : LEGACY_SET, name: g.inviteeSetId ? setName.get(String(g.inviteeSetId)) || 'Removed list' : 'Earlier invitees' },
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
  async restore(actor: Actor, eventId: string, inviteeIds: string[]) {
    const event = await manageableEvent(actor, eventId);
    const blocked = restoreBlock(event);
    if (blocked) throw fail(409, blocked, 'EVENT_NOT_ACTIVE');
    const ids = [...new Set(inviteeIds.map(String))];
    if (ids.length === 0 || ids.length > 200 || ids.some((i) => !mongoose.Types.ObjectId.isValid(i))) throw fail(400, 'Choose between 1 and 200 valid guests');

    return withEventLock(eventId, async () => {
      const eid = new mongoose.Types.ObjectId(eventId);
      const active = await Invitee.find({ eventId: eid }).select('name email mobile').lean<IInvitee[]>();
      const byEmail = new Map<string, IInvitee>(), byMobile = new Map<string, IInvitee>();
      const index = (g: IInvitee) => { if (g.email) byEmail.set(g.email.toLowerCase(), g); const m = mobileKey(g.mobile); if (m) byMobile.set(m, g); };
      active.forEach(index);
      const results: Array<{ id: string; status: 'RESTORED' | 'ALREADY_ACTIVE' | 'DUPLICATE_ACTIVE' | 'NOT_FOUND'; conflictsWith?: { id: string; name: string; matchedOn: 'email' | 'mobile' } }> = [];
      const auditBase = { actorId: actor.userId, actorRole: actor.role, eventId, organizerId: event.organizerId, entityType: 'Invitee' };

      for (const id of ids) {
        const g: any = await Invitee.findOne({ _id: id, eventId: eid }).setOptions({ includeArchived: true } as any);
        if (!g) { results.push({ id, status: 'NOT_FOUND' }); continue; }
        if (!g.archivedAt) { results.push({ id, status: 'ALREADY_ACTIVE' }); continue; }
        const emailHit = g.email ? byEmail.get(String(g.email).toLowerCase()) : undefined;
        const mobileHit = mobileKey(g.mobile) ? byMobile.get(mobileKey(g.mobile)) : undefined;
        const hit = emailHit || mobileHit;
        if (hit) {
          const conflictsWith = { id: String((hit as any)._id), name: hit.name, matchedOn: (emailHit ? 'email' : 'mobile') as 'email' | 'mobile' };
          results.push({ id, status: 'DUPLICATE_ACTIVE', conflictsWith });
          await auditLogService.record({ ...auditBase, action: 'INVITEE_RESTORE_CONFLICT', entityId: id, status: 'FAILED', description: 'Restoration refused: an active guest has the same email or mobile', metadata: { reason: 'DUPLICATE_ACTIVE', matchedOn: conflictsWith.matchedOn, conflictingInviteeId: conflictsWith.id } });
          continue;
        }
        const snapshot = { archivedAt: g.archivedAt, reason: g.archivedReason, supersededBySetId: g.supersededBySetId || null, archivedBy: g.archivedBy || null, archivedByRole: g.archivedByRole || null };
        const now = new Date();
        let done;
        try {
          done = await Invitee.updateOne(
            { _id: g._id, archivedAt: { $ne: null } },
            {
              $set: { archivedAt: null, supersededBySetId: null, archivedBy: null, archivedByRole: null, restoredAt: now, restoredBy: actor.userId },
              $unset: { archivedReason: '' },
              $push: { setAsideHistory: { ...snapshot, restoredAt: now, restoredBy: new mongoose.Types.ObjectId(actor.userId) } }
            }
          );
        } catch (e: any) {
          // The database's unique indexes (one active guest per event email / phone) refused it: someone else holds that
          // email or number right now, whichever instance put them there. The archived record is untouched.
          if (e?.code !== 11000) throw e;
          const rival = (await Invitee.find({ eventId: eid, _id: { $ne: g._id }, $or: [...(g.email ? [{ email: String(g.email).toLowerCase() }] : []), ...(g.mobile ? [{ mobileKey: mobileKey(g.mobile) }] : [])] }).limit(1).lean())[0] as any;
          const conflictsWith = { id: String(rival?._id || ''), name: rival?.name || 'another guest', matchedOn: (g.email && rival?.email === String(g.email).toLowerCase() ? 'email' : 'mobile') as 'email' | 'mobile' };
          results.push({ id, status: 'DUPLICATE_ACTIVE', conflictsWith });
          await auditLogService.record({ ...auditBase, action: 'INVITEE_RESTORE_CONFLICT', entityId: id, status: 'FAILED', description: 'Restoration refused by the database: an active guest has the same email or mobile', metadata: { reason: 'DUPLICATE_ACTIVE', matchedOn: conflictsWith.matchedOn, conflictingInviteeId: conflictsWith.id, enforcedBy: 'database' } });
          continue;
        }
        if (done.modifiedCount !== 1) { results.push({ id, status: 'ALREADY_ACTIVE' }); continue; }
        index(g);
        results.push({ id, status: 'RESTORED' });
        await auditLogService.record({ ...auditBase, action: 'INVITEE_RESTORED', entityId: id, description: 'Set-aside guest restored to the active list as Not Sent', metadata: { setId: g.inviteeSetId ? String(g.inviteeSetId) : LEGACY_SET, wasSetAsideAt: snapshot.archivedAt, reason: snapshot.reason } });
      }
      const count = (s: string) => results.filter((r) => r.status === s).length;
      return { restored: count('RESTORED'), alreadyActive: count('ALREADY_ACTIVE'), refused: count('DUPLICATE_ACTIVE'), notFound: count('NOT_FOUND'), results };
    });
  }
};

/** Why guests cannot be restored for this event right now, or null. */
export function restoreBlock(event: { status?: string; closedAt?: Date | null }): string | null {
  if (event.status === EventStatus.CANCELLED) return 'Guests cannot be restored for a cancelled event.';
  if (event.status === EventStatus.COMPLETED || event.closedAt) return 'Guests cannot be restored for a completed or closed event.';
  return null;
}
