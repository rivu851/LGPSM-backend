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
     * Same as findByEventId/countByEventId, but also joins each invitee against
     * the checkins collection (scoped to `sessionId` when given) so check-in
     * status can be filtered and paginated server-side instead of requiring the
     * caller to fetch every invitee and every check-in record to cross-reference
     * them in memory.
     */
    async findByEventIdWithCheckInStatus(eventId, options = {}) {
        const matchStage = { eventId: new mongoose_1.default.Types.ObjectId(eventId), ...(options.filter || {}) };
        const checkInMatch = { $expr: { $eq: ['$inviteeId', '$$inviteeId'] } };
        if (options.sessionId) {
            checkInMatch.sessionId = new mongoose_1.default.Types.ObjectId(options.sessionId);
        }
        const pipeline = [
            { $match: matchStage },
            {
                $lookup: {
                    from: CheckIn_1.CheckIn.collection.name,
                    let: { inviteeId: '$_id' },
                    pipeline: [{ $match: checkInMatch }, { $sort: { checkInAt: -1 } }, { $limit: 1 }],
                    as: 'checkInRecord',
                },
            },
            {
                $addFields: {
                    isCheckedIn: { $gt: [{ $size: '$checkInRecord' }, 0] },
                    checkedInAt: { $arrayElemAt: ['$checkInRecord.checkInAt', 0] },
                },
            },
        ];
        if (options.checkInStatus) {
            pipeline.push({ $match: { isCheckedIn: options.checkInStatus === 'CHECKED_IN' } });
        }
        pipeline.push({
            $facet: {
                data: [
                    { $sort: options.sort || { createdAt: -1 } },
                    { $skip: options.skip || 0 },
                    { $limit: options.limit || 25 },
                    { $project: { checkInRecord: 0 } },
                ],
                totalCount: [{ $count: 'count' }],
            },
        });
        const [result] = await Invitee_1.Invitee.aggregate(pipeline);
        const invitees = result?.data || [];
        const total = result?.totalCount?.[0]?.count || 0;
        return { invitees, total };
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
