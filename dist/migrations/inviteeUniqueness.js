"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeInviteeUniqueness = analyzeInviteeUniqueness;
exports.applyInviteeUniqueness = applyInviteeUniqueness;
exports.connectForMigration = connectForMigration;
const mongoose_1 = __importDefault(require("mongoose"));
const Invitee_1 = require("../models/Invitee");
const whatsapp_service_1 = require("../services/whatsapp.service");
const maskEmail = (e) => { const [u, d] = e.split('@'); return `${u.slice(0, 1)}***@${d || ''}`; };
const maskPhone = (k) => `…${k.slice(-3)}`;
/** Read-only. Active = archivedAt is null or the field is missing (guests from before archiving existed). */
async function analyzeInviteeUniqueness() {
    const cursor = Invitee_1.Invitee.collection.find({ archivedAt: null }, { projection: { eventId: 1, email: 1, mobile: 1, mobileKey: 1, archivedAt: 1, invitationStatus: 1, rsvpStatus: 1, createdAt: 1 } });
    const byEmail = new Map();
    const byMobile = new Map();
    let active = 0, needArchivedAt = 0, needMobileKey = 0;
    for await (const d of cursor) {
        active++;
        if (!('archivedAt' in d))
            needArchivedAt++;
        const guest = { id: String(d._id), invitationStatus: d.invitationStatus, rsvpStatus: d.rsvpStatus, createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined };
        const email = typeof d.email === 'string' ? d.email.trim().toLowerCase() : '';
        if (email) {
            const k = `${d.eventId}|${email}`;
            byEmail.set(k, [...(byEmail.get(k) || []), guest]);
        }
        const key = (0, whatsapp_service_1.normalizePhoneNumber)(d.mobile);
        if (key !== (d.mobileKey || ''))
            needMobileKey++;
        if (key) {
            const k = `${d.eventId}|${key}`;
            byMobile.set(k, [...(byMobile.get(k) || []), guest]);
        }
    }
    const conflicts = [];
    for (const [k, guests] of byEmail)
        if (guests.length > 1) {
            const [eventId, email] = k.split('|');
            conflicts.push({ type: 'EMAIL', eventId, contact: maskEmail(email), guests });
        }
    for (const [k, guests] of byMobile)
        if (guests.length > 1) {
            const [eventId, key] = k.split('|');
            conflicts.push({ type: 'MOBILE', eventId, contact: maskPhone(key), guests });
        }
    return { activeGuests: active, needArchivedAtField: needArchivedAt, needMobileKey, conflicts };
}
/** Does nothing (and says why) while any conflict remains. Otherwise fills the two derived fields and builds the indexes. */
async function applyInviteeUniqueness() {
    const report = await analyzeInviteeUniqueness();
    if (report.conflicts.length > 0)
        return { applied: false, reason: `${report.conflicts.length} duplicate active guest group(s) must be reconciled first; nothing was changed`, report };
    // 1. guests from before archiving existed get an explicit "not archived" marker, which the indexes key on
    const archivedAt = await Invitee_1.Invitee.collection.updateMany({ archivedAt: { $exists: false } }, { $set: { archivedAt: null } });
    // 2. the stored comparison form of each phone number
    const ops = [];
    let mobileKeysSet = 0;
    const cursor = Invitee_1.Invitee.collection.find({ mobile: { $type: 'string' } }, { projection: { mobile: 1, mobileKey: 1 } });
    for await (const d of cursor) {
        const key = (0, whatsapp_service_1.normalizePhoneNumber)(d.mobile);
        if (key && key !== d.mobileKey)
            ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { mobileKey: key } } } });
        if (ops.length >= 1000) {
            mobileKeysSet += ops.length;
            await Invitee_1.Invitee.collection.bulkWrite(ops.splice(0));
        }
    }
    if (ops.length) {
        mobileKeysSet += ops.length;
        await Invitee_1.Invitee.collection.bulkWrite(ops);
    }
    // 3. the unique partial indexes (an index that already exists is left alone)
    await Invitee_1.Invitee.createIndexes();
    const indexes = (await Invitee_1.Invitee.collection.indexes()).map((i) => i.name).filter((n) => n.startsWith('uniq_active_'));
    return { applied: true, report, archivedAtBackfilled: archivedAt.modifiedCount, mobileKeysSet, indexes };
}
async function connectForMigration(url) {
    await mongoose_1.default.connect(url, { serverSelectionTimeoutMS: 15000 });
}
