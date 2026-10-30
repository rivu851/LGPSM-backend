import mongoose from 'mongoose';
import { Invitee } from '../models/Invitee';
import { normalizePhoneNumber } from '../services/whatsapp.service';

// Prepares an existing database for the "one active guest per event email / phone" indexes (see models/Invitee.ts).
//
// It reports conflicts and never resolves them: no record is merged, deleted or chosen over another. Until the report is
// empty the indexes are not created and no guest is changed. Safe to run any number of times.

export interface ConflictedGuest { id: string; invitationStatus?: string; rsvpStatus?: string; createdAt?: string }
export interface UniquenessConflict {
  type: 'EMAIL' | 'MOBILE';
  eventId: string;
  /** Masked: enough to recognise the contact, not to copy it */
  contact: string;
  guests: ConflictedGuest[];
}
export interface UniquenessReport {
  activeGuests: number;
  needArchivedAtField: number;
  needMobileKey: number;
  conflicts: UniquenessConflict[];
}

const maskEmail = (e: string) => { const [u, d] = e.split('@'); return `${u.slice(0, 1)}***@${d || ''}`; };
const maskPhone = (k: string) => `…${k.slice(-3)}`;

/** Read-only. Active = archivedAt is null or the field is missing (guests from before archiving existed). */
export async function analyzeInviteeUniqueness(): Promise<UniquenessReport> {
  const cursor = Invitee.collection.find({ archivedAt: null }, { projection: { eventId: 1, email: 1, mobile: 1, mobileKey: 1, archivedAt: 1, invitationStatus: 1, rsvpStatus: 1, createdAt: 1 } });
  const byEmail = new Map<string, ConflictedGuest[]>();
  const byMobile = new Map<string, ConflictedGuest[]>();
  let active = 0, needArchivedAt = 0, needMobileKey = 0;
  for await (const d of cursor as any) {
    active++;
    if (!('archivedAt' in d)) needArchivedAt++;
    const guest: ConflictedGuest = { id: String(d._id), invitationStatus: d.invitationStatus, rsvpStatus: d.rsvpStatus, createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined };
    const email = typeof d.email === 'string' ? d.email.trim().toLowerCase() : '';
    if (email) { const k = `${d.eventId}|${email}`; byEmail.set(k, [...(byEmail.get(k) || []), guest]); }
    const key = normalizePhoneNumber(d.mobile);
    if (key !== (d.mobileKey || '')) needMobileKey++;
    if (key) { const k = `${d.eventId}|${key}`; byMobile.set(k, [...(byMobile.get(k) || []), guest]); }
  }
  const conflicts: UniquenessConflict[] = [];
  for (const [k, guests] of byEmail) if (guests.length > 1) { const [eventId, email] = k.split('|'); conflicts.push({ type: 'EMAIL', eventId, contact: maskEmail(email), guests }); }
  for (const [k, guests] of byMobile) if (guests.length > 1) { const [eventId, key] = k.split('|'); conflicts.push({ type: 'MOBILE', eventId, contact: maskPhone(key), guests }); }
  return { activeGuests: active, needArchivedAtField: needArchivedAt, needMobileKey, conflicts };
}

export interface ApplyResult { applied: boolean; reason?: string; report: UniquenessReport; archivedAtBackfilled?: number; mobileKeysSet?: number; indexes?: string[] }

/** Does nothing (and says why) while any conflict remains. Otherwise fills the two derived fields and builds the indexes. */
export async function applyInviteeUniqueness(): Promise<ApplyResult> {
  const report = await analyzeInviteeUniqueness();
  if (report.conflicts.length > 0) return { applied: false, reason: `${report.conflicts.length} duplicate active guest group(s) must be reconciled first; nothing was changed`, report };

  // 1. guests from before archiving existed get an explicit "not archived" marker, which the indexes key on
  const archivedAt = await Invitee.collection.updateMany({ archivedAt: { $exists: false } }, { $set: { archivedAt: null } });
  // 2. the stored comparison form of each phone number
  const ops: any[] = [];
  let mobileKeysSet = 0;
  const cursor = Invitee.collection.find({ mobile: { $type: 'string' } }, { projection: { mobile: 1, mobileKey: 1 } });
  for await (const d of cursor as any) {
    const key = normalizePhoneNumber(d.mobile);
    if (key && key !== d.mobileKey) ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { mobileKey: key } } } });
    if (ops.length >= 1000) { mobileKeysSet += ops.length; await Invitee.collection.bulkWrite(ops.splice(0)); }
  }
  if (ops.length) { mobileKeysSet += ops.length; await Invitee.collection.bulkWrite(ops); }
  // 3. the unique partial indexes (an index that already exists is left alone)
  await Invitee.createIndexes();
  const indexes = (await Invitee.collection.indexes()).map((i: any) => i.name as string).filter((n: string) => n.startsWith('uniq_active_'));
  return { applied: true, report, archivedAtBackfilled: archivedAt.modifiedCount, mobileKeysSet, indexes };
}

export async function connectForMigration(url: string): Promise<void> {
  await mongoose.connect(url, { serverSelectionTimeoutMS: 15000 });
}
