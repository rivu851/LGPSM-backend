import { inviteeRepository } from '../repositories/invitee.repository';
import { IInvitee, Invitee } from '../models/Invitee';
import { Event } from '../models/Event';
import { Session } from '../models/Session';
import mongoose from 'mongoose';
import * as xlsx from 'xlsx';
import { findManageableEvent } from '../utils/eventAccess';
import { InviteeSource } from '../models/Session';
import { InvitationStatus, RsvpStatus } from '../models/Invitee';
import { CheckIn } from '../models/CheckIn';

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
    
    if (options.search) {
      filter.$or = [
        { name: { $regex: options.search, $options: 'i' } },
        { email: { $regex: options.search, $options: 'i' } },
        { mobile: { $regex: options.search, $options: 'i' } }
      ];
    }

    const invitees = await inviteeRepository.findByEventId(eventId, {
      filter,
      sort: { createdAt: -1 },
      skip,
      limit
    });
    
    const total = await inviteeRepository.countByEventId(eventId, filter);

    return { invitees, total };
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

  async updateInvitee(inviteeId: string, organizerId: string, data: Partial<IInvitee>): Promise<IInvitee> {
    const invitee = await this.getInviteeById(inviteeId, organizerId); // Ensures ownership

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
    
    // Non-destructive check (if they have check-ins etc later, we might prevent this).
    // For now, hard delete.
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
  async processExcelImport(eventId: string, organizerId: string, fileBuffer: Buffer, options: { sessionId?: string; role?: string } = {}) {
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
      workbook = xlsx.read(fileBuffer, { type: 'buffer' });
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

    const nonBlankRows = rowsRaw.filter(r => Array.isArray(r) && r.some(cell => cleanCellValue(cell) !== ''));
    const results = {
      totalRows: 0,
      imported: 0,
      updated: 0,
      removed: 0,
      rejected: 0,
      duplicateCount: 0,
      errors: [] as { row: number; error: string }[]
    };
    if (nonBlankRows.length === 0) {
      throw { statusCode: 400, message: 'The sheet has no invitee rows' };
    }

    // Header matching (same rules as the frontend preview in utils/inviteeSheet.ts)
    let nameColIdx = -1, emailColIdx = -1, mobileColIdx = -1, companyColIdx = -1, dietaryColIdx = -1;
    const sessionColMap = new Map<number, string>();
    const firstRowCols = nonBlankRows[0].map((c: any) => cleanCellValue(c).toLowerCase());
    const isHeaderPresent = firstRowCols.some(
      (col: string) => col.includes('name') || col.includes('email') || col.includes('mobile') || col.includes('phone') || col.includes('company')
    );
    if (isHeaderPresent) {
      firstRowCols.forEach((colStr: string, colIdx: number) => {
        if (!colStr) return;
        if (colStr.includes('company') || colStr.includes('organization') || colStr.includes('organisation')) companyColIdx = colIdx;
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
    const isStaged = (inv: IInvitee) =>
      inv.invitationStatus === InvitationStatus.PENDING && inv.rsvpStatus === RsvpStatus.PENDING;
    const checkedInIds = new Set((await CheckIn.distinct('inviteeId', { eventId })).map(String));
    const hasHistory = (inv: IInvitee) => !isStaged(inv) || checkedInIds.has(String(inv._id));

    const byEmail = new Map<string, IInvitee>();
    const byMobile = new Map<string, IInvitee>();
    for (const inv of existingInvitees) {
      if (inv.email) byEmail.set(inv.email.toLowerCase(), inv);
      if (inv.mobile) byMobile.set(inv.mobile.replace(/\D/g, ''), inv);
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

      if (!name) { results.rejected++; results.errors.push({ row: rowNum, error: 'Name is required' }); continue; }
      if (name.length < 2 || name.length > 100) { results.rejected++; results.errors.push({ row: rowNum, error: `Invalid name '${name}' (must be 2-100 characters)` }); continue; }
      if (email && !isValidEmailFormat(email)) { results.rejected++; results.errors.push({ row: rowNum, error: `Invalid email format '${email}'` }); continue; }
      if (mobile && !isValidMobileFormat(mobile)) { results.rejected++; results.errors.push({ row: rowNum, error: `Invalid mobile number '${mobile}' (must contain 7-15 digits)` }); continue; }
      if (!email && !mobile) { results.rejected++; results.errors.push({ row: rowNum, error: 'Email or mobile is required' }); continue; }

      const mobileKey = mobile.replace(/\D/g, '');
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

      const existing = (email && byEmail.get(email)) || (mobileKey && byMobile.get(mobileKey)) || null;
      if (existing && matchedIds.has(String(existing._id))) {
        results.rejected++; results.duplicateCount++;
        results.errors.push({ row: rowNum, error: `Duplicate invitee in file (${email || mobile})` });
        continue;
      }

      if (existing) {
        matchedIds.add(String(existing._id));
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
        existing.name = name;
        if (email) existing.email = email;
        if (mobile) existing.mobile = mobile;
        if (company) { existing.companyName = company; (existing as any).company = company; }
        if (dietary) existing.dietaryPreference = dietary;
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

    if (toInsert.length > 0) {
      await inviteeRepository.insertMany(toInsert);
      results.imported = toInsert.length;
    }

    // Replace the staged list with the new file
    const notInFile = existingInvitees.filter((inv) => !matchedIds.has(String(inv._id)) && !hasHistory(inv));
    if (targetSession) {
      const sid = String(targetSession._id);
      const otherOwnSessions = ownSessionIds.filter((id) => id !== sid);
      for (const inv of notInFile) {
        const access = (inv.sessionAccess || []).map((sa) => ({ sessionId: String(sa.sessionId), allowed: sa.allowed }));
        const wasAllowed = access.length === 0 || access.some((a) => a.sessionId === sid && a.allowed);
        if (!wasAllowed) continue;
        const remaining = access.length === 0
          ? otherOwnSessions.map((sessionId) => ({ sessionId, allowed: true }))
          : access.filter((a) => a.sessionId !== sid);
        if (!remaining.some((a) => a.allowed)) {
          await Invitee.deleteOne({ _id: inv._id });
        } else {
          inv.sessionAccess = remaining.map((a) => ({ sessionId: new mongoose.Types.ObjectId(a.sessionId), allowed: a.allowed })) as any;
          await inv.save();
        }
        results.removed++;
      }
    } else if (notInFile.length > 0) {
      await Invitee.deleteMany({ _id: { $in: notInFile.map((inv) => inv._id) } });
      results.removed = notInFile.length;
    }

    return results;
  }
};
