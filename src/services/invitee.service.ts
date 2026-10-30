import { Invitation, InvitationDeliveryStatus } from '../models/Invitation';
import { credentialStatus } from '../utils/credentialPolicy';
import { inviteeRepository } from '../repositories/invitee.repository';
import { IInvitee, Invitee } from '../models/Invitee';
import { Event } from '../models/Event';
import { Session } from '../models/Session';
import mongoose from 'mongoose';
import * as xlsx from 'xlsx';
import { findManageableEvent } from '../utils/eventAccess';
import { InviteeSource } from '../models/Session';
import { InvitationStatus, RsvpStatus } from '../models/Invitee';
import { whatsappService } from './whatsapp.service';
import { CheckIn } from '../models/CheckIn';
import { InviteeSet, ImportMode } from '../models/InviteeSet';
import { lockedSetKeys, setKeyOf, loadActivity, neverAttempted, deliveryStateOf, withEventLock } from './inviteeSet.service';
import { auditLogService } from './auditLog.service';

// Upper bound for one spreadsheet import (header row excluded)
export const MAX_IMPORT_ROWS = 5000;

/** One identity per phone number regardless of formatting or a missing +91 (same normalisation WhatsApp uses). */
const mobileIdentity = (mobile?: string) => whatsappService.normalizePhoneNumber(mobile);

/** Adds each guest's CURRENT access-pass status (separate from delivery and RSVP) and, when revoked, the reason category. */
function withCredential<T>(invitees: T[], event: any): T[] {
  const now = new Date();
  return invitees.map((i: any) => {
    const plain = typeof i.toObject === 'function' ? i.toObject() : { ...i };
    const c = credentialStatus(plain, event, now);
    return { ...plain, credentialStatus: c.status, credentialStatusReason: c.reason, credentialRevocation: plain.credentialRevocation ? { category: plain.credentialRevocation.category, at: plain.credentialRevocation.at } : null };
  });
}

export const inviteeService = {
  async createInvitee(eventId: string, organizerId: string, data: Partial<IInvitee>, role?: string): Promise<IInvitee> {
    const event = await findManageableEvent(eventId, organizerId, role);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    // Check duplicates
    const duplicates = await inviteeRepository.findByEmailOrMobile(eventId, data.email, data.mobile);
    if (duplicates.length > 0) {
      throw new Error('DUPLICATE_INVITEE');
    }

    const companyVal = (data as any).companyName || (data as any).company;

    const inviteeData = {
      ...data,
      companyName: companyVal,
      company: companyVal,
      eventId: new mongoose.Types.ObjectId(eventId)
    };

    return await inviteeRepository.create(inviteeData);
  },

  async getInvitees(eventId: string, organizerId: string, options: {
    page?: number;
    limit?: number;
    rsvpStatus?: string;
    invitationStatus?: string;
    search?: string;
    sessionId?: string;
    checkInStatus?: 'CHECKED_IN' | 'PENDING';
    // Invitation-level session targeting (distinct from checkInStatus/sessionId
    // above, which are about check-in records): matches invitees who are
    // either invited to every session (no sessionAccess entries) or have an
    // explicit allowed entry for this session.
    sessionAccessId?: string;
    /** From the actual dispatch records: SENT = an invitation was delivered to them, NOT_SENT = none was */
    invitation?: 'SENT' | 'NOT_SENT';
  } = {}, role?: string) {
    const event = await findManageableEvent(eventId, organizerId, role);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    const page = options.page || 1;
    const limit = options.limit || 10;
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (options.rsvpStatus) filter.rsvpStatus = options.rsvpStatus;
    if (options.invitationStatus) filter.invitationStatus = options.invitationStatus;
    const andConditions: any[] = [];
    if (options.sessionAccessId) {
      andConditions.push({
        $or: [
          { sessionAccess: { $exists: false } },
          { sessionAccess: { $size: 0 } },
          { sessionAccess: { $elemMatch: { sessionId: options.sessionAccessId, allowed: true } } },
        ],
      });
    }

    if (options.invitation === 'SENT' || options.invitation === 'NOT_SENT') {
      // dispatch records, not "exists in the database": a guest counts as invited only if an invitation was actually delivered
      const sentIds = await Invitation.find({ eventId, status: InvitationDeliveryStatus.SENT }).distinct('inviteeId');
      andConditions.push({ _id: options.invitation === 'SENT' ? { $in: sentIds } : { $nin: sentIds } });
    }

    if (options.search) {
      const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = { $regex: escaped, $options: 'i' };
      andConditions.push({
        $or: [{ name: pattern }, { email: pattern }, { mobile: pattern }],
      });
    }

    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    // Only pay for the check-in join when the caller actually needs check-in
    // status (e.g. the check-in scanner's All/Checked-in/Pending filter) —
    // every other list screen keeps the plain, cheaper query path.
    if (options.checkInStatus || options.sessionId) {
      const { invitees, total } = await inviteeRepository.findByEventIdWithCheckInStatus(eventId, {
        filter,
        sessionId: options.sessionId,
        checkInStatus: options.checkInStatus,
        sort: { createdAt: -1, _id: -1 },
        skip,
        limit,
      });
      return { invitees: withCredential(invitees, event), total };
    }

    const invitees = await inviteeRepository.findByEventId(eventId, {
      filter,
      sort: { createdAt: -1, _id: -1 },
      skip,
      limit
    });

    const total = await inviteeRepository.countByEventId(eventId, filter);

    return { invitees: withCredential(invitees, event), total };
  },

  async getInviteeById(inviteeId: string, organizerId: string): Promise<IInvitee> {
    const invitee = await inviteeRepository.findById(inviteeId);
    if (!invitee) {
      throw new Error('INVITEE_NOT_FOUND');
    }

    const event = await findManageableEvent(invitee.eventId.toString(), organizerId);
    if (!event) {
      throw new Error('INVITEE_NOT_FOUND');
    }

    return invitee;
  },

  /** True when this guest came from an uploaded list that an invitation was sent from, answered or attended (Locked). */
  async inLockedUploadedSet(invitee: IInvitee): Promise<boolean> {
    if (!invitee.inviteeSetId) return false; // guests added by hand are not part of an uploaded list
    const members = await Invitee.find({ eventId: invitee.eventId, inviteeSetId: invitee.inviteeSetId }).select('invitationStatus rsvpStatus qrTokenHash inviteeSetId');
    return lockedSetKeys(members, await loadActivity(invitee.eventId, members)).size > 0;
  },

  async updateInvitee(inviteeId: string, organizerId: string, data: Partial<IInvitee>): Promise<IInvitee> {
    const invitee = await this.getInviteeById(inviteeId, organizerId); // Ensures ownership

    // A Locked list keeps who was on it: its guests' details are not rewritten (dietary choice and session access have their own routes)
    const DETAIL_FIELDS = ['name', 'email', 'mobile', 'companyName', 'company', 'professionalIdentity'] as const;
    const changes = DETAIL_FIELDS.some((f) => (data as any)[f] !== undefined && String((data as any)[f] ?? '') !== String((invitee as any)[f] ?? ''));
    if (changes && (await this.inLockedUploadedSet(invitee))) throw new Error('SET_LOCKED');

    // Check duplicates if email/mobile changed
    if (
      (data.email && data.email !== invitee.email) || 
      (data.mobile && data.mobile !== invitee.mobile)
    ) {
      const emailToCheck = data.email || invitee.email;
      const mobileToCheck = data.mobile || invitee.mobile;
      const duplicates = await inviteeRepository.findByEmailOrMobile(invitee.eventId.toString(), emailToCheck, mobileToCheck);
      
      const isDuplicate = duplicates.some(dup => (dup as any)._id.toString() !== inviteeId);
      if (isDuplicate) {
        throw new Error('DUPLICATE_INVITEE');
      }
    }

    // Protect system fields
    delete (data as any)._id;
    delete (data as any).eventId;
    delete (data as any).createdAt;
    delete (data as any).invitationStatus; // Handled by separate workflows

    const updated = await inviteeRepository.update(inviteeId, data);
    if (!updated) {
      throw new Error('UPDATE_FAILED');
    }
    return updated;
  },

  async updateSessionAccess(inviteeId: string, organizerId: string, sessionAccess: { sessionId: string; allowed: boolean }[]): Promise<IInvitee> {
    const invitee = await this.getInviteeById(inviteeId, organizerId);
    const eventId = invitee.eventId.toString();

    // Verify all sessions belong to the event
    const sessionIds = sessionAccess.map(sa => sa.sessionId);
    const sessions = await Session.find({ _id: { $in: sessionIds }, eventId });
    if (sessions.length !== sessionIds.length) {
      throw new Error('INVALID_SESSIONS');
    }

    // Merge or replace? The spec asks to "Preserve the existing access entries if the operation is intended to be partial. Clearly distinguish replace-all behavior from partial updates."
    // Let's implement replace-all for the provided session IDs. (Partial update on the array).
    const accessMap = new Map<string, boolean>();
    invitee.sessionAccess.forEach(sa => accessMap.set(sa.sessionId.toString(), sa.allowed));
    
    sessionAccess.forEach(sa => accessMap.set(sa.sessionId, sa.allowed));

    const newSessionAccess = Array.from(accessMap.entries()).map(([sessionId, allowed]) => ({
      sessionId: new mongoose.Types.ObjectId(sessionId),
      allowed
    }));

    const updated = await inviteeRepository.update(inviteeId, { sessionAccess: newSessionAccess });
    if (!updated) {
      throw new Error('UPDATE_FAILED');
    }
    return updated;
  },

  async bulkUpdateSessionAccess(eventId: string, organizerId: string, inviteeIds: string[], sessionAccess: { sessionId: string; allowed: boolean }[]) {
    const event = await findManageableEvent(eventId, organizerId);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    // Verify all invitees belong to event
    const invitees = await Invitee.find({ _id: { $in: inviteeIds }, eventId });
    if (invitees.length !== inviteeIds.length) {
      throw new Error('INVALID_INVITEES');
    }

    // Verify all sessions belong to event
    const sessionIds = sessionAccess.map(sa => sa.sessionId);
    const sessions = await Session.find({ _id: { $in: sessionIds }, eventId });
    if (sessions.length !== sessionIds.length) {
      throw new Error('INVALID_SESSIONS');
    }

    // For simplicity in bulk update, we replace the session access completely 
    // or we can't easily do a partial merge in MongoDB without complex aggregation pipelines.
    // The prompt says "Avoid partial database updates when the chosen operation is intended to be atomic."
    // We will replace the sessionAccess entirely for the bulk updated invitees.
    
    const mappedSessionAccess = sessionAccess.map(sa => ({
      sessionId: new mongoose.Types.ObjectId(sa.sessionId),
      allowed: sa.allowed
    }));

    await inviteeRepository.bulkUpdateSessionAccess(inviteeIds, mappedSessionAccess);

    return { success: true, updatedCount: invitees.length };
  },

  async deleteInvitee(inviteeId: string, organizerId: string): Promise<IInvitee> {
    const invitee = await this.getInviteeById(inviteeId, organizerId);

    // A guest nothing has happened to can be removed from an open or hand-made list. Anyone who was invited, answered,
    // attended, or sits in a Locked list stays: removing them would erase history.
    if (await this.inLockedUploadedSet(invitee)) throw new Error('SET_LOCKED');
    const a = (await loadActivity(invitee.eventId, [invitee])).get(String(invitee._id))!;
    if (!neverAttempted(a)) throw new Error('HAS_HISTORY');
    const deleted = await inviteeRepository.delete(inviteeId);
    if (!deleted) {
      throw new Error('DELETE_FAILED');
    }
    return deleted;
  },

  // Imports an invitee sheet. The latest upload is authoritative for the not-yet-invited ("staged")
  // list: staged invitees missing from the new file are dropped (event-wide upload) or lose access to
  /**
   * Processes Excel import for an event or session.
   *
   * Product Staging vs History Preservation Rule:
   * - Unsent / Staging Data: Invitee records that are still PENDING (not yet sent an invitation pass)
   *   and have no check-in logs are replaced by a new Excel upload if omitted from the new file.
   * - Historical Data Preservation: Guests with active delivery history (SENT, FAILED), RSVP responses
   *   (ACCEPTED, DECLINED), or recorded Check-Ins are NEVER deleted or reset. Their contact details
   *   and session access are safely updated/expanded without wiping their invitation or check-in state.
   */
  async processExcelImport(eventId: string, organizerId: string, fileBuffer: Buffer, options: { sessionId?: string; role?: string; mode?: ImportMode; fileName?: string } = {}) {
    // one import (or restore) per event at a time: the duplicate checks read the list and then write to it
    return withEventLock(eventId, () => inviteeService.runExcelImport(eventId, organizerId, fileBuffer, options));
  },

  async runExcelImport(eventId: string, organizerId: string, fileBuffer: Buffer, options: { sessionId?: string; role?: string; mode?: ImportMode; fileName?: string } = {}) {
    const mode = options.mode === ImportMode.APPEND ? ImportMode.APPEND : ImportMode.REPLACE;
    const event = await findManageableEvent(eventId, organizerId, options.role);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    const eventSessions = await Session.find({ eventId });
    let targetSession: (typeof eventSessions)[number] | undefined;
    if (options.sessionId) {
      targetSession = eventSessions.find((s) => String(s._id) === options.sessionId);
      if (!targetSession) throw { statusCode: 400, message: 'The session does not belong to this event' };
      if (targetSession.inviteeSource === InviteeSource.COPY_SESSION) {
        throw { statusCode: 400, message: `"${targetSession.name}" keeps the same invitees as another session; upload the list to that session instead` };
      }
    }

    let workbook: xlsx.WorkBook;
    try {
      // sheetRows bounds how much of a (possibly highly compressed) sheet is ever materialised
      workbook = xlsx.read(fileBuffer, { type: 'buffer', sheetRows: MAX_IMPORT_ROWS + 2 });
    } catch {
      throw { statusCode: 400, message: 'The file could not be read as an Excel sheet' };
    }
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rowsRaw = (sheet ? xlsx.utils.sheet_to_json<any[]>(sheet, { header: 1 }) : []) || [];

    // Formula errors and stringified objects are treated as empty cells
    const cleanCellValue = (val: any): string => {
      if (val === null || val === undefined) return '';
      const str = String(val).trim();
      if (!str) return '';
      const formulaErrors = ['#VALUE!', '#N/A', '#REF!', '#DIV/0!', '#NAME?', '#NUM!', '#NULL!', '[OBJECT OBJECT]'];
      if (formulaErrors.some(err => str.toUpperCase().includes(err))) return '';
      return str;
    };
    const isValidEmailFormat = (v: string) => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v);
    const isValidMobileFormat = (v: string) => {
      const digits = v.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15;
    };

    if (rowsRaw.length > MAX_IMPORT_ROWS + 1) {
      throw { statusCode: 400, message: `A sheet can contain at most ${MAX_IMPORT_ROWS} invitees. Split the file and import it in parts.` };
    }

    const nonBlankRows = rowsRaw.filter(r => Array.isArray(r) && r.some(cell => cleanCellValue(cell) !== ''));
    const results = {
      totalRows: 0,
      imported: 0,
      updated: 0,
      removed: 0,
      // never-invited guests of an earlier list that this upload replaced: archived, not deleted
      archived: 0,
      // guests in lists that were already sent (kept whole); rows that matched them are not imported again
      alreadyInvited: 0,
      // guests of earlier lists with a failed or unresolved delivery: always kept, never set aside
      failedKept: 0,
      unknownKept: 0,
      preservedSets: 0,
      setId: null as string | null,
      mode,
      rejected: 0,
      duplicateCount: 0,
      errors: [] as { row: number; error: string }[],
      // Rows that matched an existing guest whose details differ: the existing details were kept
      notices: [] as { row: number; message: string }[]
    };
    if (nonBlankRows.length === 0) {
      throw { statusCode: 400, message: 'The sheet has no invitee rows' };
    }

    // Header matching (same rules as the frontend preview in utils/inviteeSheet.ts)
    let nameColIdx = -1, emailColIdx = -1, mobileColIdx = -1, companyColIdx = -1, dietaryColIdx = -1, identityColIdx = -1;
    const sessionColMap = new Map<number, string>();
    const firstRowCols = nonBlankRows[0].map((c: any) => cleanCellValue(c).toLowerCase());
    const isHeaderPresent = firstRowCols.some(
      (col: string) => col.includes('name') || col.includes('email') || col.includes('mobile') || col.includes('phone') || col.includes('company')
    );
    if (isHeaderPresent) {
      firstRowCols.forEach((colStr: string, colIdx: number) => {
        if (!colStr) return;
        if (colStr.includes('identity') || colStr.includes('designation')) identityColIdx = colIdx;
        else if (colStr.includes('company') || colStr.includes('organization') || colStr.includes('organisation')) companyColIdx = colIdx;
        else if (colStr.includes('name')) nameColIdx = colIdx;
        else if (colStr.includes('email') || colStr.includes('mail')) emailColIdx = colIdx;
        else if (colStr.includes('mobile') || colStr.includes('phone') || colStr.includes('contact') || colStr.includes('whatsapp')) mobileColIdx = colIdx;
        else if (colStr.includes('diet') || colStr.includes('food') || colStr.includes('meal')) dietaryColIdx = colIdx;
        // Per-session Y/N columns only apply to event-wide uploads
        if (!targetSession) {
          for (const session of eventSessions) {
            if (session.inviteeSource !== InviteeSource.COPY_SESSION && colStr === session.name.toLowerCase()) {
              sessionColMap.set(colIdx, String(session._id));
            }
          }
        }
      });
    } else {
      nameColIdx = 0; emailColIdx = 1; mobileColIdx = 2; companyColIdx = 3; dietaryColIdx = 4;
    }

    const dataRows = isHeaderPresent ? nonBlankRows.slice(1) : nonBlankRows;
    results.totalRows = dataRows.length;
    const cell = (row: any[], idx: number) => (idx !== -1 && row[idx] !== undefined ? cleanCellValue(row[idx]) : '');

    const existingInvitees = await Invitee.find({ eventId });
    // What has really happened to each guest: delivery records, access passes, RSVPs and check-ins, not only the guest row
    const activity = await loadActivity(eventId, existingInvitees);
    const hasHistory = (inv: IInvitee) => !neverAttempted(activity.get(String(inv._id))!);
    // Lists an invitation has been dispatched from (or answered, or attended): kept whole, whatever the new file contains
    const lockedSets = lockedSetKeys(existingInvitees, activity);
    const inLockedSet = (inv: IInvitee) => lockedSets.has(setKeyOf(inv));

    const byEmail = new Map<string, IInvitee>();
    const byMobile = new Map<string, IInvitee>();
    for (const inv of existingInvitees) {
      if (inv.email) byEmail.set(inv.email.toLowerCase(), inv);
      if (inv.mobile) byMobile.set(mobileIdentity(inv.mobile), inv);
    }

    const ownSessionIds = eventSessions.filter((s) => s.inviteeSource !== InviteeSource.COPY_SESSION).map((s) => String(s._id));
    const matchedIds = new Set<string>();
    const seenEmails = new Set<string>();
    const seenMobiles = new Set<string>();
    const toInsert: any[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = i + (isHeaderPresent ? 2 : 1);
      const name = cell(row, nameColIdx);
      const email = cell(row, emailColIdx).toLowerCase();
      const mobile = cell(row, mobileColIdx);
      const company = cell(row, companyColIdx);
      const dietary = cell(row, dietaryColIdx);
      const professionalIdentity = cell(row, identityColIdx).slice(0, 100);

      if (!name) { results.rejected++; results.errors.push({ row: rowNum, error: 'Name is required' }); continue; }
      if (name.length < 2 || name.length > 100) { results.rejected++; results.errors.push({ row: rowNum, error: `Invalid name '${name}' (must be 2-100 characters)` }); continue; }
      if (email && !isValidEmailFormat(email)) { results.rejected++; results.errors.push({ row: rowNum, error: `Invalid email format '${email}'` }); continue; }
      if (mobile && !isValidMobileFormat(mobile)) { results.rejected++; results.errors.push({ row: rowNum, error: `Invalid mobile number '${mobile}' (must contain 7-15 digits)` }); continue; }
      if (!email && !mobile) { results.rejected++; results.errors.push({ row: rowNum, error: 'Email or mobile is required' }); continue; }

      const mobileKey = mobileIdentity(mobile);
      if ((email && seenEmails.has(email)) || (mobileKey && seenMobiles.has(mobileKey))) {
        results.rejected++; results.duplicateCount++;
        results.errors.push({ row: rowNum, error: `Duplicate invitee in file (${email || mobile})` });
        continue;
      }
      if (email) seenEmails.add(email);
      if (mobileKey) seenMobiles.add(mobileKey);

      // Access granted by this row
      let rowAccess: { sessionId: string; allowed: boolean }[];
      if (targetSession) {
        rowAccess = [{ sessionId: String(targetSession._id), allowed: true }];
      } else if (sessionColMap.size > 0) {
        rowAccess = [...sessionColMap.entries()].map(([colIdx, sessionId]) => {
          const v = cleanCellValue(row[colIdx]).toUpperCase();
          return { sessionId, allowed: !['N', 'NO', 'FALSE', '0'].includes(v) };
        });
      } else {
        rowAccess = ownSessionIds.map((sessionId) => ({ sessionId, allowed: true }));
      }

      const emailMatch = email ? byEmail.get(email) : undefined;
      const mobileMatch = mobileKey ? byMobile.get(mobileKey) : undefined;
      if (emailMatch && mobileMatch && String(emailMatch._id) !== String(mobileMatch._id)) {
        results.rejected++;
        results.errors.push({ row: rowNum, error: `Email ${email} belongs to ${emailMatch.name} but mobile ${mobile} belongs to ${mobileMatch.name}` });
        continue;
      }
      const existing = emailMatch || mobileMatch || null;
      if (existing && matchedIds.has(String(existing._id))) {
        results.rejected++; results.duplicateCount++;
        results.errors.push({ row: rowNum, error: `Duplicate invitee in file (${email || mobile})` });
        continue;
      }

      if (existing) {
        matchedIds.add(String(existing._id));
        if (hasHistory(existing) || inLockedSet(existing)) results.alreadyInvited++;
        const access = new Map<string, boolean>((existing.sessionAccess || []).map((sa) => [String(sa.sessionId), sa.allowed]));
        const hadImplicitAll = access.size === 0;
        if (targetSession) {
          if (!hadImplicitAll) access.set(String(targetSession._id), true);
        } else if (hasHistory(existing)) {
          // Already invited: never take access away
          if (!hadImplicitAll) rowAccess.filter((a) => a.allowed).forEach((a) => access.set(a.sessionId, true));
        } else {
          access.clear();
          rowAccess.forEach((a) => access.set(a.sessionId, a.allowed));
        }
        // Only fill what the guest is missing; never replace their details with different (or blank) values, and
        // never take an email or number another guest on this event already has
        const kept: string[] = [];
        if (name !== existing.name) kept.push(`name '${existing.name}'`);
        if (email) {
          if (!existing.email && !byEmail.has(email)) { existing.email = email; byEmail.set(email, existing); }
          else if (existing.email && existing.email.toLowerCase() !== email) kept.push(`email '${existing.email}'`);
        }
        if (mobileKey) {
          if (!existing.mobile && !byMobile.has(mobileKey)) { existing.mobile = mobile; byMobile.set(mobileKey, existing); }
          else if (existing.mobile && mobileIdentity(existing.mobile) !== mobileKey) kept.push(`mobile '${existing.mobile}'`);
        }
        const existingCompany = existing.companyName || (existing as any).company;
        if (company) {
          if (!existingCompany) { existing.companyName = company; (existing as any).company = company; }
          else if (existingCompany !== company) kept.push(`company '${existingCompany}'`);
        }
        if (professionalIdentity && !existing.professionalIdentity) existing.professionalIdentity = professionalIdentity;
        if (dietary) {
          if (!existing.dietaryPreference) existing.dietaryPreference = dietary;
          else if (existing.dietaryPreference !== dietary) kept.push(`dietary preference '${existing.dietaryPreference}'`);
        }
        if (kept.length) results.notices.push({ row: rowNum, message: `Matches ${existing.name}; kept the existing ${kept.join(', ')}` });
        existing.sessionAccess = [...access.entries()].map(([sessionId, allowed]) => ({ sessionId: new mongoose.Types.ObjectId(sessionId), allowed })) as any;
        await existing.save();
        results.updated++;
      } else {
        toInsert.push({
          eventId: new mongoose.Types.ObjectId(eventId),
          name,
          email: email || undefined,
          mobile: mobile || undefined,
          companyName: company || undefined,
          company: company || undefined,
          dietaryPreference: dietary || undefined,
          professionalIdentity: professionalIdentity || undefined,
          sessionAccess: rowAccess.map((a) => ({ sessionId: new mongoose.Types.ObjectId(a.sessionId), allowed: a.allowed })),
          invitationStatus: InvitationStatus.PENDING,
          rsvpStatus: RsvpStatus.PENDING
        });
      }
    }

    // A file where every row was rejected must not wipe the current list
    if (matchedIds.size === 0 && toInsert.length === 0) {
      return results;
    }

    // The upload becomes its own list; guests already in the event are never copied into it
    let newSetId: mongoose.Types.ObjectId | null = null;
    if (toInsert.length > 0) {
      const created = await InviteeSet.create({
        eventId: new mongoose.Types.ObjectId(eventId),
        sessionId: targetSession ? targetSession._id : null,
        name: (options.fileName || 'Uploaded list').slice(0, 200),
        mode,
        createdBy: new mongoose.Types.ObjectId(organizerId),
        createdByRole: options.role,
        importedCount: toInsert.length
      });
      newSetId = created._id as mongoose.Types.ObjectId;
      results.setId = String(newSetId);
      toInsert.forEach((row) => { row.inviteeSetId = newSetId; });
      try {
        await inviteeRepository.insertMany(toInsert);
      } catch (err) {
        // nothing was archived yet; take the half-made list back out so the event looks exactly as before the upload
        await Invitee.deleteMany({ inviteeSetId: newSetId, invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING }).setOptions({ includeArchived: true } as any);
        await InviteeSet.deleteOne({ _id: newSetId });
        throw err;
      }
      results.imported = toInsert.length;
    }

    // Replace: only never-invited guests of unlocked lists can be superseded, and they are archived, not deleted.
    // Append (and any guest with history, or in a locked list) leaves everything as it was.
    if (mode === ImportMode.REPLACE) {
      const notInFile = existingInvitees.filter((inv) => !matchedIds.has(String(inv._id)) && !hasHistory(inv) && !inLockedSet(inv));
      results.preservedSets = lockedSets.size;
      // guests of earlier lists whose delivery failed or never settled are not "never invited": they are kept and stay retryable
      for (const inv of existingInvitees) {
        if (matchedIds.has(String(inv._id))) continue;
        const state = deliveryStateOf(activity.get(String(inv._id))!);
        if (state === 'FAILED') results.failedKept++;
        else if (state === 'UNKNOWN') results.unknownKept++;
      }
      const actorId = new mongoose.Types.ObjectId(organizerId);
      const archive = async (ids: mongoose.Types.ObjectId[]) => {
        if (!ids.length) return;
        const now = new Date();
        try {
          // The conditions are re-checked by the database in the same step, so a guest who was invited a moment ago is skipped
          const res = await Invitee.updateMany(
            { _id: { $in: ids }, archivedAt: null, invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING, qrTokenHash: null },
            { $set: { archivedAt: now, archivedReason: 'SUPERSEDED_BY_UPLOAD', supersededBySetId: newSetId, archivedBy: actorId, archivedByRole: options.role } }
          );
          results.archived += res.modifiedCount;
          results.removed += res.modifiedCount;
        } catch (err) {
          // undo whatever part was applied and take the new list back out, so a failed Replace changes nothing
          await Invitee.updateMany({ supersededBySetId: newSetId, archivedBy: actorId }, { $set: { archivedAt: null, supersededBySetId: null, archivedBy: null, archivedByRole: null }, $unset: { archivedReason: '' } });
          if (newSetId) {
            await Invitee.deleteMany({ inviteeSetId: newSetId, invitationStatus: InvitationStatus.PENDING, rsvpStatus: RsvpStatus.PENDING });
            await InviteeSet.deleteOne({ _id: newSetId });
          }
          throw err;
        }
      };
      if (targetSession) {
        const sid = String(targetSession._id);
        const otherOwnSessions = ownSessionIds.filter((id) => id !== sid);
        const toArchive: mongoose.Types.ObjectId[] = [];
        for (const inv of notInFile) {
          const access = (inv.sessionAccess || []).map((sa) => ({ sessionId: String(sa.sessionId), allowed: sa.allowed }));
          const wasAllowed = access.length === 0 || access.some((a) => a.sessionId === sid && a.allowed);
          if (!wasAllowed) continue;
          const remaining = access.length === 0
            ? otherOwnSessions.map((sessionId) => ({ sessionId, allowed: true }))
            : access.filter((a) => a.sessionId !== sid);
          if (!remaining.some((a) => a.allowed)) {
            toArchive.push(inv._id as mongoose.Types.ObjectId);
          } else {
            inv.sessionAccess = remaining.map((a) => ({ sessionId: new mongoose.Types.ObjectId(a.sessionId), allowed: a.allowed })) as any;
            await inv.save();
            results.removed++;
          }
        }
        await archive(toArchive);
      } else {
        await archive(notInFile.map((inv) => inv._id as mongoose.Types.ObjectId));
      }
    }

    if (results.archived > 0) {
      // one summary entry: who set how many guests aside, because of which upload (the guests themselves carry the same facts)
      await auditLogService.record({
        actorId: organizerId, actorRole: options.role, eventId, organizerId: (event as any).organizerId,
        action: 'INVITEE_SET_ASIDE', entityType: 'InviteeSet', entityId: newSetId,
        description: 'Never-invited guests set aside by a Replace',
        metadata: { setId: results.setId, mode, archived: results.archived, failedKept: results.failedKept, unknownKept: results.unknownKept, preservedSets: results.preservedSets }
      });
    }

    return results;
  }
};
