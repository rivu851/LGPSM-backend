"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventRepository = exports.EventRepository = void 0;
const Invitee_1 = require("../models/Invitee");
const Session_1 = require("../models/Session");
const Event_1 = require("../models/Event");
class EventRepository {
    async create(data) {
        const event = new Event_1.Event(data);
        return await event.save();
    }
    async findByOrganizer(organizerId, filter, pagination) {
        const query = { organizerId };
        if (filter.status)
            query.status = filter.status;
        if (filter.categoryId)
            query.categoryId = filter.categoryId;
        const skip = (pagination.page - 1) * pagination.limit;
        const [events, total] = await Promise.all([
            Event_1.Event.find(query)
                .populate(LIST_POPULATE)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(pagination.limit)
                .exec(),
            Event_1.Event.countDocuments(query)
        ]);
        return { events: await withInvitationCounts(events), total };
    }
    // Admin-wide listing, optionally narrowed to one organizer
    async findAll(filter, pagination) {
        const query = {};
        if (filter.organizerId)
            query.organizerId = filter.organizerId;
        if (filter.status)
            query.status = filter.status;
        if (filter.categoryId)
            query.categoryId = filter.categoryId;
        const skip = (pagination.page - 1) * pagination.limit;
        const [events, total] = await Promise.all([
            Event_1.Event.find(query)
                .populate(LIST_POPULATE)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(pagination.limit)
                .exec(),
            Event_1.Event.countDocuments(query)
        ]);
        return { events: await withInvitationCounts(events), total };
    }
    async findByIdAndOrganizer(eventId, organizerId) {
        return await Event_1.Event.findOne({ _id: eventId, organizerId }).exec();
    }
    async updateByIdAndOrganizer(eventId, organizerId, updateData) {
        return await Event_1.Event.findOneAndUpdate({ _id: eventId, organizerId }, { $set: updateData }, { new: true, runValidators: true }).exec();
    }
    async softDeleteByIdAndOrganizer(eventId, organizerId) {
        return await Event_1.Event.findOneAndUpdate({ _id: eventId, organizerId }, { $set: { status: Event_1.EventStatus.CANCELLED } }, { new: true }).exec();
    }
}
exports.EventRepository = EventRepository;
// List rows show the organisation, category and whether invitations went out
const LIST_POPULATE = [
    { path: 'organizerId', select: 'fullName email profile.organizationName profile.logoKey' },
    { path: 'categoryId', select: 'name subcategories' }
];
// Number of invitees per event who were sent an invitation (or a send was attempted),
// plus each event's session names for the list card's "Sessions: X, Y" line.
async function withInvitationCounts(events) {
    if (events.length === 0)
        return [];
    const eventIds = events.map((e) => e._id);
    const [counts, sessions] = await Promise.all([
        Invitee_1.Invitee.aggregate([
            { $match: { eventId: { $in: eventIds }, invitationStatus: { $ne: 'PENDING' } } },
            { $group: { _id: '$eventId', count: { $sum: 1 } } }
        ]),
        Session_1.Session.find({ eventId: { $in: eventIds } }, 'eventId name').sort({ 'schedule.start': 1 }).lean()
    ]);
    const byEvent = new Map(counts.map((c) => [String(c._id), c.count]));
    const sessionsByEvent = new Map();
    sessions.forEach((s) => {
        const key = String(s.eventId);
        const list = sessionsByEvent.get(key) ?? [];
        list.push(s.name);
        sessionsByEvent.set(key, list);
    });
    return events.map((e) => {
        const json = e.toJSON();
        const category = json.categoryId;
        if (json.subcategoryId && category && Array.isArray(category.subcategories)) {
            const sub = category.subcategories.find((x) => String(x._id) === String(json.subcategoryId));
            if (sub)
                json.subcategory = { _id: sub._id, name: sub.name };
        }
        if (category)
            delete category.subcategories;
        json.invitationsSent = byEvent.get(String(e._id)) || 0;
        json.sessionNames = sessionsByEvent.get(String(e._id)) || [];
        return json;
    });
}
exports.eventRepository = new EventRepository();
