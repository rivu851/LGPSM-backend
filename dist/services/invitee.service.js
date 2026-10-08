"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteeService = void 0;
const invitee_repository_1 = require("../repositories/invitee.repository");
const Invitee_1 = require("../models/Invitee");
const Session_1 = require("../models/Session");
const mongoose_1 = __importDefault(require("mongoose"));
const xlsx = __importStar(require("xlsx"));
const eventAccess_1 = require("../utils/eventAccess");
const Session_2 = require("../models/Session");
const Invitee_2 = require("../models/Invitee");
const CheckIn_1 = require("../models/CheckIn");
exports.inviteeService = {
    async createInvitee(eventId, organizerId, data, role) {
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, organizerId, role);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        // Check duplicates
        const duplicates = await invitee_repository_1.inviteeRepository.findByEmailOrMobile(eventId, data.email, data.mobile);
        if (duplicates.length > 0) {
            throw new Error('DUPLICATE_INVITEE');
        }
        const companyVal = data.companyName || data.company;
        const inviteeData = {
            ...data,
            companyName: companyVal,
            company: companyVal,
            eventId: new mongoose_1.default.Types.ObjectId(eventId)
        };
        return await invitee_repository_1.inviteeRepository.create(inviteeData);
    },
    async getInvitees(eventId, organizerId, options = {}, role) {
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, organizerId, role);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        const page = options.page || 1;
        const limit = options.limit || 10;
        const skip = (page - 1) * limit;
        const filter = {};
        if (options.rsvpStatus)
            filter.rsvpStatus = options.rsvpStatus;
        if (options.invitationStatus)
            filter.invitationStatus = options.invitationStatus;
        if (options.search) {
            filter.$or = [
                { name: { $regex: options.search, $options: 'i' } },
                { email: { $regex: options.search, $options: 'i' } },
                { mobile: { $regex: options.search, $options: 'i' } }
            ];
        }
        const invitees = await invitee_repository_1.inviteeRepository.findByEventId(eventId, {
            filter,
            sort: { createdAt: -1 },
            skip,
            limit
        });
        const total = await invitee_repository_1.inviteeRepository.countByEventId(eventId, filter);
        return { invitees, total };
    },
    async getInviteeById(inviteeId, organizerId) {
        const invitee = await invitee_repository_1.inviteeRepository.findById(inviteeId);
        if (!invitee) {
            throw new Error('INVITEE_NOT_FOUND');
        }
        const event = await (0, eventAccess_1.findManageableEvent)(invitee.eventId.toString(), organizerId);
        if (!event) {
            throw new Error('INVITEE_NOT_FOUND');
        }
        return invitee;
    },
    async updateInvitee(inviteeId, organizerId, data) {
        const invitee = await this.getInviteeById(inviteeId, organizerId); // Ensures ownership
        // Check duplicates if email/mobile changed
        if ((data.email && data.email !== invitee.email) ||
            (data.mobile && data.mobile !== invitee.mobile)) {
            const emailToCheck = data.email || invitee.email;
            const mobileToCheck = data.mobile || invitee.mobile;
            const duplicates = await invitee_repository_1.inviteeRepository.findByEmailOrMobile(invitee.eventId.toString(), emailToCheck, mobileToCheck);
            const isDuplicate = duplicates.some(dup => dup._id.toString() !== inviteeId);
            if (isDuplicate) {
                throw new Error('DUPLICATE_INVITEE');
            }
        }
        // Protect system fields
        delete data._id;
        delete data.eventId;
        delete data.createdAt;
        delete data.invitationStatus; // Handled by separate workflows
        const updated = await invitee_repository_1.inviteeRepository.update(inviteeId, data);
        if (!updated) {
            throw new Error('UPDATE_FAILED');
        }
        return updated;
    },
    async updateSessionAccess(inviteeId, organizerId, sessionAccess) {
        const invitee = await this.getInviteeById(inviteeId, organizerId);
        const eventId = invitee.eventId.toString();
        // Verify all sessions belong to the event
        const sessionIds = sessionAccess.map(sa => sa.sessionId);
        const sessions = await Session_1.Session.find({ _id: { $in: sessionIds }, eventId });
        if (sessions.length !== sessionIds.length) {
            throw new Error('INVALID_SESSIONS');
        }
        // Merge or replace? The spec asks to "Preserve the existing access entries if the operation is intended to be partial. Clearly distinguish replace-all behavior from partial updates."
        // Let's implement replace-all for the provided session IDs. (Partial update on the array).
        const accessMap = new Map();
        invitee.sessionAccess.forEach(sa => accessMap.set(sa.sessionId.toString(), sa.allowed));
        sessionAccess.forEach(sa => accessMap.set(sa.sessionId, sa.allowed));
        const newSessionAccess = Array.from(accessMap.entries()).map(([sessionId, allowed]) => ({
            sessionId: new mongoose_1.default.Types.ObjectId(sessionId),
            allowed
        }));
        const updated = await invitee_repository_1.inviteeRepository.update(inviteeId, { sessionAccess: newSessionAccess });
        if (!updated) {
            throw new Error('UPDATE_FAILED');
        }
        return updated;
    },
    async bulkUpdateSessionAccess(eventId, organizerId, inviteeIds, sessionAccess) {
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, organizerId);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        // Verify all invitees belong to event
        const invitees = await Invitee_1.Invitee.find({ _id: { $in: inviteeIds }, eventId });
        if (invitees.length !== inviteeIds.length) {
            throw new Error('INVALID_INVITEES');
        }
        // Verify all sessions belong to event
        const sessionIds = sessionAccess.map(sa => sa.sessionId);
        const sessions = await Session_1.Session.find({ _id: { $in: sessionIds }, eventId });
        if (sessions.length !== sessionIds.length) {
            throw new Error('INVALID_SESSIONS');
        }
        // For simplicity in bulk update, we replace the session access completely 
        // or we can't easily do a partial merge in MongoDB without complex aggregation pipelines.
        // The prompt says "Avoid partial database updates when the chosen operation is intended to be atomic."
        // We will replace the sessionAccess entirely for the bulk updated invitees.
        const mappedSessionAccess = sessionAccess.map(sa => ({
            sessionId: new mongoose_1.default.Types.ObjectId(sa.sessionId),
            allowed: sa.allowed
        }));
        await invitee_repository_1.inviteeRepository.bulkUpdateSessionAccess(inviteeIds, mappedSessionAccess);
        return { success: true, updatedCount: invitees.length };
    },
    async deleteInvitee(inviteeId, organizerId) {
        const invitee = await this.getInviteeById(inviteeId, organizerId);
        // Non-destructive check (if they have check-ins etc later, we might prevent this).
        // For now, hard delete.
        const deleted = await invitee_repository_1.inviteeRepository.delete(inviteeId);
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
    async processExcelImport(eventId, organizerId, fileBuffer, options = {}) {
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, organizerId, options.role);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        const eventSessions = await Session_1.Session.find({ eventId });
        let targetSession;
        if (options.sessionId) {
            targetSession = eventSessions.find((s) => String(s._id) === options.sessionId);
            if (!targetSession)
                throw { statusCode: 400, message: 'The session does not belong to this event' };
            if (targetSession.inviteeSource === Session_2.InviteeSource.COPY_SESSION) {
                throw { statusCode: 400, message: `"${targetSession.name}" keeps the same invitees as another session; upload the list to that session instead` };
            }
        }
        let workbook;
        try {
            workbook = xlsx.read(fileBuffer, { type: 'buffer' });
        }
        catch {
            throw { statusCode: 400, message: 'The file could not be read as an Excel sheet' };
        }
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rowsRaw = (sheet ? xlsx.utils.sheet_to_json(sheet, { header: 1 }) : []) || [];
        // Formula errors and stringified objects are treated as empty cells
        const cleanCellValue = (val) => {
            if (val === null || val === undefined)
                return '';
            const str = String(val).trim();
            if (!str)
                return '';
            const formulaErrors = ['#VALUE!', '#N/A', '#REF!', '#DIV/0!', '#NAME?', '#NUM!', '#NULL!', '[OBJECT OBJECT]'];
            if (formulaErrors.some(err => str.toUpperCase().includes(err)))
                return '';
            return str;
        };
        const isValidEmailFormat = (v) => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v);
        const isValidMobileFormat = (v) => {
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
            errors: []
        };
        if (nonBlankRows.length === 0) {
            throw { statusCode: 400, message: 'The sheet has no invitee rows' };
        }
        // Header matching (same rules as the frontend preview in utils/inviteeSheet.ts)
        let nameColIdx = -1, emailColIdx = -1, mobileColIdx = -1, companyColIdx = -1, dietaryColIdx = -1;
        const sessionColMap = new Map();
        const firstRowCols = nonBlankRows[0].map((c) => cleanCellValue(c).toLowerCase());
        const isHeaderPresent = firstRowCols.some((col) => col.includes('name') || col.includes('email') || col.includes('mobile') || col.includes('phone') || col.includes('company'));
        if (isHeaderPresent) {
            firstRowCols.forEach((colStr, colIdx) => {
                if (!colStr)
                    return;
                if (colStr.includes('company') || colStr.includes('organization') || colStr.includes('organisation'))
                    companyColIdx = colIdx;
                else if (colStr.includes('name'))
                    nameColIdx = colIdx;
                else if (colStr.includes('email') || colStr.includes('mail'))
                    emailColIdx = colIdx;
                else if (colStr.includes('mobile') || colStr.includes('phone') || colStr.includes('contact') || colStr.includes('whatsapp'))
                    mobileColIdx = colIdx;
                else if (colStr.includes('diet') || colStr.includes('food') || colStr.includes('meal'))
                    dietaryColIdx = colIdx;
                // Per-session Y/N columns only apply to event-wide uploads
                if (!targetSession) {
                    for (const session of eventSessions) {
                        if (session.inviteeSource !== Session_2.InviteeSource.COPY_SESSION && colStr === session.name.toLowerCase()) {
                            sessionColMap.set(colIdx, String(session._id));
                        }
                    }
                }
            });
        }
        else {
            nameColIdx = 0;
            emailColIdx = 1;
            mobileColIdx = 2;
            companyColIdx = 3;
            dietaryColIdx = 4;
        }
        const dataRows = isHeaderPresent ? nonBlankRows.slice(1) : nonBlankRows;
        results.totalRows = dataRows.length;
        const cell = (row, idx) => (idx !== -1 && row[idx] !== undefined ? cleanCellValue(row[idx]) : '');
        const existingInvitees = await Invitee_1.Invitee.find({ eventId });
        const isStaged = (inv) => inv.invitationStatus === Invitee_2.InvitationStatus.PENDING && inv.rsvpStatus === Invitee_2.RsvpStatus.PENDING;
        const checkedInIds = new Set((await CheckIn_1.CheckIn.distinct('inviteeId', { eventId })).map(String));
        const hasHistory = (inv) => !isStaged(inv) || checkedInIds.has(String(inv._id));
        const byEmail = new Map();
        const byMobile = new Map();
        for (const inv of existingInvitees) {
            if (inv.email)
                byEmail.set(inv.email.toLowerCase(), inv);
            if (inv.mobile)
                byMobile.set(inv.mobile.replace(/\D/g, ''), inv);
        }
        const ownSessionIds = eventSessions.filter((s) => s.inviteeSource !== Session_2.InviteeSource.COPY_SESSION).map((s) => String(s._id));
        const matchedIds = new Set();
        const seenEmails = new Set();
        const seenMobiles = new Set();
        const toInsert = [];
        for (let i = 0; i < dataRows.length; i++) {
            const row = dataRows[i];
            const rowNum = i + (isHeaderPresent ? 2 : 1);
            const name = cell(row, nameColIdx);
            const email = cell(row, emailColIdx).toLowerCase();
            const mobile = cell(row, mobileColIdx);
            const company = cell(row, companyColIdx);
            const dietary = cell(row, dietaryColIdx);
            if (!name) {
                results.rejected++;
                results.errors.push({ row: rowNum, error: 'Name is required' });
                continue;
            }
            if (name.length < 2 || name.length > 100) {
                results.rejected++;
                results.errors.push({ row: rowNum, error: `Invalid name '${name}' (must be 2-100 characters)` });
                continue;
            }
            if (email && !isValidEmailFormat(email)) {
                results.rejected++;
                results.errors.push({ row: rowNum, error: `Invalid email format '${email}'` });
                continue;
            }
            if (mobile && !isValidMobileFormat(mobile)) {
                results.rejected++;
                results.errors.push({ row: rowNum, error: `Invalid mobile number '${mobile}' (must contain 7-15 digits)` });
                continue;
            }
            if (!email && !mobile) {
                results.rejected++;
                results.errors.push({ row: rowNum, error: 'Email or mobile is required' });
                continue;
            }
            const mobileKey = mobile.replace(/\D/g, '');
            if ((email && seenEmails.has(email)) || (mobileKey && seenMobiles.has(mobileKey))) {
                results.rejected++;
                results.duplicateCount++;
                results.errors.push({ row: rowNum, error: `Duplicate invitee in file (${email || mobile})` });
                continue;
            }
            if (email)
                seenEmails.add(email);
            if (mobileKey)
                seenMobiles.add(mobileKey);
            // Access granted by this row
            let rowAccess;
            if (targetSession) {
                rowAccess = [{ sessionId: String(targetSession._id), allowed: true }];
            }
            else if (sessionColMap.size > 0) {
                rowAccess = [...sessionColMap.entries()].map(([colIdx, sessionId]) => {
                    const v = cleanCellValue(row[colIdx]).toUpperCase();
                    return { sessionId, allowed: !['N', 'NO', 'FALSE', '0'].includes(v) };
                });
            }
            else {
                rowAccess = ownSessionIds.map((sessionId) => ({ sessionId, allowed: true }));
            }
            const existing = (email && byEmail.get(email)) || (mobileKey && byMobile.get(mobileKey)) || null;
            if (existing && matchedIds.has(String(existing._id))) {
                results.rejected++;
                results.duplicateCount++;
                results.errors.push({ row: rowNum, error: `Duplicate invitee in file (${email || mobile})` });
                continue;
            }
            if (existing) {
                matchedIds.add(String(existing._id));
                const access = new Map((existing.sessionAccess || []).map((sa) => [String(sa.sessionId), sa.allowed]));
                const hadImplicitAll = access.size === 0;
                if (targetSession) {
                    if (!hadImplicitAll)
                        access.set(String(targetSession._id), true);
                }
                else if (hasHistory(existing)) {
                    // Already invited: never take access away
                    if (!hadImplicitAll)
                        rowAccess.filter((a) => a.allowed).forEach((a) => access.set(a.sessionId, true));
                }
                else {
                    access.clear();
                    rowAccess.forEach((a) => access.set(a.sessionId, a.allowed));
                }
                existing.name = name;
                if (email)
                    existing.email = email;
                if (mobile)
                    existing.mobile = mobile;
                if (company) {
                    existing.companyName = company;
                    existing.company = company;
                }
                if (dietary)
                    existing.dietaryPreference = dietary;
                existing.sessionAccess = [...access.entries()].map(([sessionId, allowed]) => ({ sessionId: new mongoose_1.default.Types.ObjectId(sessionId), allowed }));
                await existing.save();
                results.updated++;
            }
            else {
                toInsert.push({
                    eventId: new mongoose_1.default.Types.ObjectId(eventId),
                    name,
                    email: email || undefined,
                    mobile: mobile || undefined,
                    companyName: company || undefined,
                    company: company || undefined,
                    dietaryPreference: dietary || undefined,
                    sessionAccess: rowAccess.map((a) => ({ sessionId: new mongoose_1.default.Types.ObjectId(a.sessionId), allowed: a.allowed })),
                    invitationStatus: Invitee_2.InvitationStatus.PENDING,
                    rsvpStatus: Invitee_2.RsvpStatus.PENDING
                });
            }
        }
        // A file where every row was rejected must not wipe the current list
        if (matchedIds.size === 0 && toInsert.length === 0) {
            return results;
        }
        if (toInsert.length > 0) {
            await invitee_repository_1.inviteeRepository.insertMany(toInsert);
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
                if (!wasAllowed)
                    continue;
                const remaining = access.length === 0
                    ? otherOwnSessions.map((sessionId) => ({ sessionId, allowed: true }))
                    : access.filter((a) => a.sessionId !== sid);
                if (!remaining.some((a) => a.allowed)) {
                    await Invitee_1.Invitee.deleteOne({ _id: inv._id });
                }
                else {
                    inv.sessionAccess = remaining.map((a) => ({ sessionId: new mongoose_1.default.Types.ObjectId(a.sessionId), allowed: a.allowed }));
                    await inv.save();
                }
                results.removed++;
            }
        }
        else if (notInFile.length > 0) {
            await Invitee_1.Invitee.deleteMany({ _id: { $in: notInFile.map((inv) => inv._id) } });
            results.removed = notInFile.length;
        }
        return results;
    }
};
