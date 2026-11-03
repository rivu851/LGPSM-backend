"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteeRepository = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const Invitee_1 = require("../models/Invitee");
const CheckIn_1 = require("../models/CheckIn");
exports.inviteeRepository = {
    /**
     * One page of guests with each guest's check-in state (within `sessionId` when given). This runs after every door scan, so its cost must
     * not grow with the size of the guest list: the people who checked in are read first when the list is filtered by that, and only the
     * guests on the page are then looked up. (It used to join every guest of the event against the check-ins before taking one page.)
     */
    async findByEventIdWithCheckInStatus(eventId, options = {}) {
        const eventObjectId = new mongoose_1.default.Types.ObjectId(eventId);
        const checkInScope = { eventId: eventObjectId };
        if (options.sessionId)
            checkInScope.sessionId = new mongoose_1.default.Types.ObjectId(options.sessionId);
        const match = { eventId: eventObjectId, ...(options.filter || {}) };
        if (options.checkInStatus) {
            const attended = await CheckIn_1.CheckIn.distinct('inviteeId', checkInScope);
            match._id = options.checkInStatus === 'CHECKED_IN' ? { $in: attended } : { $nin: attended };
        }
        const [rows, total] = await Promise.all([
            Invitee_1.Invitee.find(match)
                .sort(options.sort || { createdAt: -1 })
                .skip(options.skip || 0)
                .limit(options.limit || 25)
                .lean(),
            Invitee_1.Invitee.countDocuments(match),
        ]);
        const records = await CheckIn_1.CheckIn.find({ ...checkInScope, inviteeId: { $in: rows.map((r) => r._id) } })
            .select('inviteeId checkInAt')
            .sort({ checkInAt: 1 })
            .lean();
        // Ascending, so the latest check-in for a guest is the one that stays
        const latest = new Map(records.map((r) => [String(r.inviteeId), r.checkInAt]));
        const invitees = rows.map((r) => ({ ...r, isCheckedIn: latest.has(String(r._id)), checkedInAt: latest.get(String(r._id)) ?? undefined }));
        return { invitees: invitees, total };
    },
    async create(data) {
        const invitee = new Invitee_1.Invitee(data);
        return await invitee.save();
    },
    async insertMany(data) {
        return await Invitee_1.Invitee.insertMany(data);
    },
    async findByEventId(eventId, options = {}) {
        const filter = { eventId, ...(options.filter || {}) };
        let query = Invitee_1.Invitee.find(filter);
        if (options.sort) {
            query = query.sort(options.sort);
        }
        if (options.skip !== undefined) {
            query = query.skip(options.skip);
        }
        if (options.limit !== undefined) {
            query = query.limit(options.limit);
        }
        return await query.exec();
    },
    async countByEventId(eventId, filter = {}) {
        return await Invitee_1.Invitee.countDocuments({ eventId, ...filter });
    },
    async findById(inviteeId) {
        return await Invitee_1.Invitee.findById(inviteeId);
    },
    async findByEmailOrMobile(eventId, email, mobile) {
        const orConditions = [];
        if (email)
            orConditions.push({ email: email.toLowerCase() });
        if (mobile)
            orConditions.push({ mobile });
        if (orConditions.length === 0)
            return [];
        return await Invitee_1.Invitee.find({ eventId, $or: orConditions });
    },
    async update(inviteeId, data) {
        // load + save (not findByIdAndUpdate) so that validation runs and the derived phone key stays in step with the phone number
        const doc = await Invitee_1.Invitee.findById(inviteeId);
        if (!doc)
            return null;
        doc.set(data);
        return await doc.save();
    },
    async bulkUpdateSessionAccess(inviteeIds, sessionAccess) {
        return await Invitee_1.Invitee.updateMany({ _id: { $in: inviteeIds } }, { $set: { sessionAccess } }, { runValidators: true });
    },
    async delete(inviteeId) {
        return await Invitee_1.Invitee.findByIdAndDelete(inviteeId);
    }
};
