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
exports.inviteeService = exports.MAX_IMPORT_ROWS = void 0;
const Invitation_1 = require("../models/Invitation");
const credentialPolicy_1 = require("../utils/credentialPolicy");
const invitee_repository_1 = require("../repositories/invitee.repository");
const Invitee_1 = require("../models/Invitee");
const Session_1 = require("../models/Session");
const mongoose_1 = __importDefault(require("mongoose"));
const xlsx = __importStar(require("xlsx"));
const eventAccess_1 = require("../utils/eventAccess");
const Session_2 = require("../models/Session");
const Invitee_2 = require("../models/Invitee");
const whatsapp_service_1 = require("./whatsapp.service");
const InviteeSet_1 = require("../models/InviteeSet");
const inviteeSet_service_1 = require("./inviteeSet.service");
const auditLog_service_1 = require("./auditLog.service");
// Upper bound for one spreadsheet import (header row excluded)
exports.MAX_IMPORT_ROWS = 5000;
/** One identity per phone number regardless of formatting or a missing +91 (same normalisation WhatsApp uses). */
const mobileIdentity = (mobile) => whatsapp_service_1.whatsappService.normalizePhoneNumber(mobile);
/** Adds each guest's CURRENT access-pass status (separate from delivery and RSVP) and, when revoked, the reason category. */
function withCredential(invitees, event) {
    const now = new Date();
    return invitees.map((i) => {
        const plain = typeof i.toObject === 'function' ? i.toObject() : { ...i };
        const c = (0, credentialPolicy_1.credentialStatus)(plain, event, now);
        return { ...plain, credentialStatus: c.status, credentialStatusReason: c.reason, credentialRevocation: plain.credentialRevocation ? { category: plain.credentialRevocation.category, at: plain.credentialRevocation.at } : null };
    });
}
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
        const andConditions = [];
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
            const sentIds = await Invitation_1.Invitation.find({ eventId, status: Invitation_1.InvitationDeliveryStatus.SENT }).distinct('inviteeId');
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
            const { invitees, total } = await invitee_repository_1.inviteeRepository.findByEventIdWithCheckInStatus(eventId, {
                filter,
                sessionId: options.sessionId,
                checkInStatus: options.checkInStatus,
                sort: { createdAt: -1, _id: -1 },
                skip,
                limit,
            });
            return { invitees: withCredential(invitees, event), total };
        }
        const invitees = await invitee_repository_1.inviteeRepository.findByEventId(eventId, {
            filter,
            sort: { createdAt: -1, _id: -1 },
            skip,
            limit
        });
        const total = await invitee_repository_1.inviteeRepository.countByEventId(eventId, filter);
        return { invitees: withCredential(invitees, event), total };
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
    /** True when this guest came from an uploaded list that an invitation was sent from, answered or attended (Locked). */
    async inLockedUploadedSet(invitee) {
        if (!invitee.inviteeSetId)
            return false; // guests added by hand are not part of an uploaded list
        const members = await Invitee_1.Invitee.find({ eventId: invitee.eventId, inviteeSetId: invitee.inviteeSetId }).select('invitationStatus rsvpStatus qrTokenHash inviteeSetId');
        return (0, inviteeSet_service_1.lockedSetKeys)(members, await (0, inviteeSet_service_1.loadActivity)(invitee.eventId, members)).size > 0;
    },
    async updateInvitee(inviteeId, organizerId, data) {
        const invitee = await this.getInviteeById(inviteeId, organizerId); // Ensures ownership
        // A Locked list keeps who was on it: its guests' details are not rewritten (dietary choice and session access have their own routes)
        const DETAIL_FIELDS = ['name', 'email', 'mobile', 'companyName', 'company', 'professionalIdentity'];
        const changes = DETAIL_FIELDS.some((f) => data[f] !== undefined && String(data[f] ?? '') !== String(invitee[f] ?? ''));
        if (changes && (await this.inLockedUploadedSet(invitee)))
            throw new Error('SET_LOCKED');
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
        // A guest nothing has happened to can be removed from an open or hand-made list. Anyone who was invited, answered,
        // attended, or sits in a Locked list stays: removing them would erase history.
        if (await this.inLockedUploadedSet(invitee))
            throw new Error('SET_LOCKED');
        const a = (await (0, inviteeSet_service_1.loadActivity)(invitee.eventId, [invitee])).get(String(invitee._id));
        if (!(0, inviteeSet_service_1.neverAttempted)(a))
            throw new Error('HAS_HISTORY');
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
        // one import (or restore) per event at a time: the duplicate checks read the list and then write to it
        return (0, inviteeSet_service_1.withEventLock)(eventId, () => exports.inviteeService.runExcelImport(eventId, organizerId, fileBuffer, options));
    },
    async runExcelImport(eventId, organizerId, fileBuffer, options = {}) {
        const mode = options.mode === InviteeSet_1.ImportMode.APPEND ? InviteeSet_1.ImportMode.APPEND : InviteeSet_1.ImportMode.REPLACE;
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
            // sheetRows bounds how much of a (possibly highly compressed) sheet is ever materialised
            workbook = xlsx.read(fileBuffer, { type: 'buffer', sheetRows: exports.MAX_IMPORT_ROWS + 2 });
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
        if (rowsRaw.length > exports.MAX_IMPORT_ROWS + 1) {
            throw { statusCode: 400, message: `A sheet can contain at most ${exports.MAX_IMPORT_ROWS} invitees. Split the file and import it in parts.` };
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
            setId: null,
            mode,
            rejected: 0,
            duplicateCount: 0,
            errors: [],
            // Rows that matched an existing guest whose details differ: the existing details were kept
            notices: []
        };
        if (nonBlankRows.length === 0) {
            throw { statusCode: 400, message: 'The sheet has no invitee rows' };
        }
        // Header matching (same rules as the frontend preview in utils/inviteeSheet.ts)
        let nameColIdx = -1, emailColIdx = -1, mobileColIdx = -1, companyColIdx = -1, dietaryColIdx = -1, identityColIdx = -1;
        const sessionColMap = new Map();
        const firstRowCols = nonBlankRows[0].map((c) => cleanCellValue(c).toLowerCase());
        const isHeaderPresent = firstRowCols.some((col) => col.includes('name') || col.includes('email') || col.includes('mobile') || col.includes('phone') || col.includes('company'));
        if (isHeaderPresent) {
            firstRowCols.forEach((colStr, colIdx) => {
                if (!colStr)
                    return;
                if (colStr.includes('identity') || colStr.includes('designation'))
                    identityColIdx = colIdx;
                else if (colStr.includes('company') || colStr.includes('organization') || colStr.includes('organisation'))
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
        // What has really happened to each guest: delivery records, access passes, RSVPs and check-ins, not only the guest row
        const activity = await (0, inviteeSet_service_1.loadActivity)(eventId, existingInvitees);
        const hasHistory = (inv) => !(0, inviteeSet_service_1.neverAttempted)(activity.get(String(inv._id)));
        // Lists an invitation has been dispatched from (or answered, or attended): kept whole, whatever the new file contains
        const lockedSets = (0, inviteeSet_service_1.lockedSetKeys)(existingInvitees, activity);
        const inLockedSet = (inv) => lockedSets.has((0, inviteeSet_service_1.setKeyOf)(inv));
        const byEmail = new Map();
        const byMobile = new Map();
        for (const inv of existingInvitees) {
            if (inv.email)
                byEmail.set(inv.email.toLowerCase(), inv);
            if (inv.mobile)
                byMobile.set(mobileIdentity(inv.mobile), inv);
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
            const professionalIdentity = cell(row, identityColIdx).slice(0, 100);
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
            const mobileKey = mobileIdentity(mobile);
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
            const emailMatch = email ? byEmail.get(email) : undefined;
            const mobileMatch = mobileKey ? byMobile.get(mobileKey) : undefined;
            if (emailMatch && mobileMatch && String(emailMatch._id) !== String(mobileMatch._id)) {
                results.rejected++;
                results.errors.push({ row: rowNum, error: `Email ${email} belongs to ${emailMatch.name} but mobile ${mobile} belongs to ${mobileMatch.name}` });
                continue;
            }
            const existing = emailMatch || mobileMatch || null;
            if (existing && matchedIds.has(String(existing._id))) {
                results.rejected++;
                results.duplicateCount++;
                results.errors.push({ row: rowNum, error: `Duplicate invitee in file (${email || mobile})` });
                continue;
            }
            if (existing) {
                matchedIds.add(String(existing._id));
                if (hasHistory(existing) || inLockedSet(existing))
                    results.alreadyInvited++;
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
                // Only fill what the guest is missing; never replace their details with different (or blank) values, and
                // never take an email or number another guest on this event already has
                const kept = [];
                if (name !== existing.name)
                    kept.push(`name '${existing.name}'`);
                if (email) {
                    if (!existing.email && !byEmail.has(email)) {
                        existing.email = email;
                        byEmail.set(email, existing);
                    }
                    else if (existing.email && existing.email.toLowerCase() !== email)
                        kept.push(`email '${existing.email}'`);
                }
                if (mobileKey) {
                    if (!existing.mobile && !byMobile.has(mobileKey)) {
                        existing.mobile = mobile;
                        byMobile.set(mobileKey, existing);
                    }
                    else if (existing.mobile && mobileIdentity(existing.mobile) !== mobileKey)
                        kept.push(`mobile '${existing.mobile}'`);
                }
                const existingCompany = existing.companyName || existing.company;
                if (company) {
                    if (!existingCompany) {
                        existing.companyName = company;
                        existing.company = company;
                    }
                    else if (existingCompany !== company)
                        kept.push(`company '${existingCompany}'`);
                }
                if (professionalIdentity && !existing.professionalIdentity)
                    existing.professionalIdentity = professionalIdentity;
                if (dietary) {
                    if (!existing.dietaryPreference)
                        existing.dietaryPreference = dietary;
                    else if (existing.dietaryPreference !== dietary)
                        kept.push(`dietary preference '${existing.dietaryPreference}'`);
                }
                if (kept.length)
                    results.notices.push({ row: rowNum, message: `Matches ${existing.name}; kept the existing ${kept.join(', ')}` });
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
                    professionalIdentity: professionalIdentity || undefined,
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
        // The upload becomes its own list; guests already in the event are never copied into it
        let newSetId = null;
        if (toInsert.length > 0) {
            const created = await InviteeSet_1.InviteeSet.create({
                eventId: new mongoose_1.default.Types.ObjectId(eventId),
                sessionId: targetSession ? targetSession._id : null,
                name: (options.fileName || 'Uploaded list').slice(0, 200),
                mode,
                createdBy: new mongoose_1.default.Types.ObjectId(organizerId),
                createdByRole: options.role,
                importedCount: toInsert.length
            });
            newSetId = created._id;
            results.setId = String(newSetId);
            toInsert.forEach((row) => { row.inviteeSetId = newSetId; });
            try {
                await invitee_repository_1.inviteeRepository.insertMany(toInsert);
            }
            catch (err) {
                // nothing was archived yet; take the half-made list back out so the event looks exactly as before the upload
                await Invitee_1.Invitee.deleteMany({ inviteeSetId: newSetId, invitationStatus: Invitee_2.InvitationStatus.PENDING, rsvpStatus: Invitee_2.RsvpStatus.PENDING }).setOptions({ includeArchived: true });
                await InviteeSet_1.InviteeSet.deleteOne({ _id: newSetId });
                throw err;
            }
            results.imported = toInsert.length;
        }
        // Replace: only never-invited guests of unlocked lists can be superseded, and they are archived, not deleted.
        // Append (and any guest with history, or in a locked list) leaves everything as it was.
        if (mode === InviteeSet_1.ImportMode.REPLACE) {
            const notInFile = existingInvitees.filter((inv) => !matchedIds.has(String(inv._id)) && !hasHistory(inv) && !inLockedSet(inv));
            results.preservedSets = lockedSets.size;
            // guests of earlier lists whose delivery failed or never settled are not "never invited": they are kept and stay retryable
            for (const inv of existingInvitees) {
                if (matchedIds.has(String(inv._id)))
                    continue;
                const state = (0, inviteeSet_service_1.deliveryStateOf)(activity.get(String(inv._id)));
                if (state === 'FAILED')
                    results.failedKept++;
                else if (state === 'UNKNOWN')
                    results.unknownKept++;
            }
            const actorId = new mongoose_1.default.Types.ObjectId(organizerId);
            const archive = async (ids) => {
                if (!ids.length)
                    return;
                const now = new Date();
                try {
                    // The conditions are re-checked by the database in the same step, so a guest who was invited a moment ago is skipped
                    const res = await Invitee_1.Invitee.updateMany({ _id: { $in: ids }, archivedAt: null, invitationStatus: Invitee_2.InvitationStatus.PENDING, rsvpStatus: Invitee_2.RsvpStatus.PENDING, qrTokenHash: null }, { $set: { archivedAt: now, archivedReason: 'SUPERSEDED_BY_UPLOAD', supersededBySetId: newSetId, archivedBy: actorId, archivedByRole: options.role } });
                    results.archived += res.modifiedCount;
                    results.removed += res.modifiedCount;
                }
                catch (err) {
                    // undo whatever part was applied and take the new list back out, so a failed Replace changes nothing
                    await Invitee_1.Invitee.updateMany({ supersededBySetId: newSetId, archivedBy: actorId }, { $set: { archivedAt: null, supersededBySetId: null, archivedBy: null, archivedByRole: null }, $unset: { archivedReason: '' } });
                    if (newSetId) {
                        await Invitee_1.Invitee.deleteMany({ inviteeSetId: newSetId, invitationStatus: Invitee_2.InvitationStatus.PENDING, rsvpStatus: Invitee_2.RsvpStatus.PENDING });
                        await InviteeSet_1.InviteeSet.deleteOne({ _id: newSetId });
                    }
                    throw err;
                }
            };
            if (targetSession) {
                const sid = String(targetSession._id);
                const otherOwnSessions = ownSessionIds.filter((id) => id !== sid);
                const toArchive = [];
                for (const inv of notInFile) {
                    const access = (inv.sessionAccess || []).map((sa) => ({ sessionId: String(sa.sessionId), allowed: sa.allowed }));
                    const wasAllowed = access.length === 0 || access.some((a) => a.sessionId === sid && a.allowed);
                    if (!wasAllowed)
                        continue;
                    const remaining = access.length === 0
                        ? otherOwnSessions.map((sessionId) => ({ sessionId, allowed: true }))
                        : access.filter((a) => a.sessionId !== sid);
                    if (!remaining.some((a) => a.allowed)) {
                        toArchive.push(inv._id);
                    }
                    else {
                        inv.sessionAccess = remaining.map((a) => ({ sessionId: new mongoose_1.default.Types.ObjectId(a.sessionId), allowed: a.allowed }));
                        await inv.save();
                        results.removed++;
                    }
                }
                await archive(toArchive);
            }
            else {
                await archive(notInFile.map((inv) => inv._id));
            }
        }
        if (results.archived > 0) {
            // one summary entry: who set how many guests aside, because of which upload (the guests themselves carry the same facts)
            await auditLog_service_1.auditLogService.record({
                actorId: organizerId, actorRole: options.role, eventId, organizerId: event.organizerId,
                action: 'INVITEE_SET_ASIDE', entityType: 'InviteeSet', entityId: newSetId,
                description: 'Never-invited guests set aside by a Replace',
                metadata: { setId: results.setId, mode, archived: results.archived, failedKept: results.failedKept, unknownKept: results.unknownKept, preservedSets: results.preservedSets }
            });
        }
        return results;
    }
};
