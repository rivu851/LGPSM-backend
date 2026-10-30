import { Invitee } from '../models/Invitee';
import { Event } from '../models/Event';
import { credentialStatus } from '../utils/credentialPolicy';

// READ-ONLY inventory of how every active guest's access pass is held, per event. It never writes, never decrypts anything
// and never returns a token, a token hash, an encrypted copy, a name, an email address or a phone number: only counts.
//
// How the two models are told apart (see utils/credentialTokens.ts):
//   LEGACY_SHARED : qrTokenHash present, invitationTokenHash absent  -> one secret is both the link and the QR
//   SEPARATED     : invitationTokenHash present and different from qrTokenHash
//     MIGRATED    : ...and that invitation hash equals a hash the guest's pass history shows as an earlier pass (the old shared
//                   token was adopted as the link when the pass was replaced or re-sent)
//     NATIVE      : ...otherwise (issued under the separated model from the start)
//   NOT_ISSUED    : no pass yet
//   UNDETERMINED  : the record contradicts itself (a hash without its pair, "sent" with no pass, both secrets identical)

export interface EventInventory {
  eventId: string;
  title: string;
  status: string;
  activeGuests: number;
  notIssued: number;
  legacyShared: number;
  separatedNative: number;
  separatedMigrated: number;
  undetermined: number;
  /** pass state of guests who hold one (a revoked pass counts as revoked; otherwise the event's own state decides expired / active) */
  passState: { active: number; revoked: number; expired: number };
  /** Legacy guests: could a re-send (which keeps their link and issues a new QR) do it for them today, and if not, the first reason */
  legacyMigration: { resendable: number; blocked: { eventNotPublished: number; revoked: number; noContact: number; noInvitationRecord: number; linkWouldChange: number } };
}

export interface CredentialInventory {
  generatedAt: string;
  totals: Omit<EventInventory, 'eventId' | 'title' | 'status'>;
  events: EventInventory[];
}

const blank = (): Omit<EventInventory, 'eventId' | 'title' | 'status'> => ({
  activeGuests: 0, notIssued: 0, legacyShared: 0, separatedNative: 0, separatedMigrated: 0, undetermined: 0,
  passState: { active: 0, revoked: 0, expired: 0 },
  legacyMigration: { resendable: 0, blocked: { eventNotPublished: 0, revoked: 0, noContact: 0, noInvitationRecord: 0, linkWouldChange: 0 } }
});

export async function credentialInventory(): Promise<CredentialInventory> {
  // Booleans are computed in the database, so no secret or contact detail ever reaches this process.
  const rows: any[] = await Invitee.collection.aggregate([
    { $match: { archivedAt: null } },
    { $lookup: { from: 'credentialevents', localField: '_id', foreignField: 'inviteeId', as: 'ev', pipeline: [{ $project: { tokenHash: 1 } }] } },
    { $lookup: { from: 'invitations', localField: '_id', foreignField: 'inviteeId', as: 'inv', pipeline: [{ $project: { _id: 1 } }] } },
    { $project: {
      eventId: 1, invitationStatus: 1,
      hasPass: { $gt: [{ $strLenCP: { $ifNull: ['$qrTokenHash', ''] } }, 0] },
      hasLinkHash: { $gt: [{ $strLenCP: { $ifNull: ['$invitationTokenHash', ''] } }, 0] },
      sameSecret: { $and: [{ $gt: [{ $strLenCP: { $ifNull: ['$qrTokenHash', ''] } }, 0] }, { $eq: ['$qrTokenHash', '$invitationTokenHash'] }] },
      adopted: { $in: ['$invitationTokenHash', { $map: { input: '$ev', as: 'e', in: '$$e.tokenHash' } }] },
      hasQrCipher: { $gt: [{ $strLenCP: { $ifNull: ['$qrTokenCipher', ''] } }, 0] },
      revoked: { $ne: [{ $ifNull: ['$credentialRevokedAt', null] }, null] },
      hasEmail: { $gt: [{ $strLenCP: { $ifNull: ['$email', ''] } }, 0] },
      hasMobile: { $gt: [{ $strLenCP: { $ifNull: ['$mobile', ''] } }, 0] },
      hasInvitationRecord: { $gt: [{ $size: '$inv' }, 0] }
    } }
  ]).toArray();

  const events = await Event.find({ _id: { $in: [...new Set(rows.map((r) => String(r.eventId)))] } }).select('title status schedule admission').lean();
  const byEvent = new Map<string, EventInventory>();
  const eventDoc = new Map<string, any>(events.map((e: any) => [String(e._id), e]));
  const now = new Date();
  for (const r of rows) {
    const key = String(r.eventId);
    const ev: any = eventDoc.get(key);
    let inv = byEvent.get(key);
    if (!inv) { inv = { eventId: key, title: String(ev?.title ?? '(event not found)').slice(0, 60), status: ev?.status ?? 'UNKNOWN', ...blank() }; byEvent.set(key, inv); }
    inv.activeGuests++;
    const inconsistent = (!r.hasPass && (r.invitationStatus === 'SENT' || r.hasLinkHash)) || r.sameSecret;
    if (inconsistent) { inv.undetermined++; continue; }
    if (!r.hasPass) { inv.notIssued++; continue; }
    // pass state
    const expired = ev && credentialStatus({ qrTokenHash: 'x' }, ev, now).status === 'EXPIRED';
    if (r.revoked) inv.passState.revoked++; else if (expired) inv.passState.expired++; else inv.passState.active++;
    if (r.hasLinkHash) { if (r.adopted) inv.separatedMigrated++; else inv.separatedNative++; continue; }
    // legacy shared token
    inv.legacyShared++;
    const b = inv.legacyMigration.blocked;
    if (ev?.status !== 'PUBLISHED') b.eventNotPublished++;
    else if (r.revoked) b.revoked++;
    else if (!r.hasInvitationRecord) b.noInvitationRecord++;
    else if (!r.hasEmail && !r.hasMobile) b.noContact++;
    else if (!r.hasQrCipher) b.linkWouldChange++; // the old link cannot be adopted, so a re-send would give a new link
    else inv.legacyMigration.resendable++;
  }
  const list = [...byEvent.values()].sort((a, b) => b.legacyShared - a.legacyShared || a.title.localeCompare(b.title));
  const totals = blank();
  for (const e of list) {
    for (const k of ['activeGuests', 'notIssued', 'legacyShared', 'separatedNative', 'separatedMigrated', 'undetermined'] as const) totals[k] += e[k];
    for (const k of ['active', 'revoked', 'expired'] as const) totals.passState[k] += e.passState[k];
    totals.legacyMigration.resendable += e.legacyMigration.resendable;
    for (const k of Object.keys(totals.legacyMigration.blocked) as Array<keyof typeof totals.legacyMigration.blocked>) totals.legacyMigration.blocked[k] += e.legacyMigration.blocked[k];
  }
  return { generatedAt: now.toISOString(), totals, events: list };
}
