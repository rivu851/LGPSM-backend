import { Invitee } from '../models/Invitee';
import { Event, IEvent, EventStatus } from '../models/Event';
import mongoose from 'mongoose';

export interface EventFilter {
  status?: EventStatus;
  categoryId?: string;
}

export interface Pagination {
  page: number;
  limit: number;
}

export class EventRepository {
  async create(data: Partial<IEvent>): Promise<IEvent> {
    const event = new Event(data);
    return await event.save();
  }

  async findByOrganizer(
    organizerId: string | mongoose.Types.ObjectId,
    filter: EventFilter,
    pagination: Pagination
  ): Promise<{ events: IEvent[]; total: number }> {
    const query: any = { organizerId };
    
    if (filter.status) query.status = filter.status;
    if (filter.categoryId) query.categoryId = filter.categoryId;

    const skip = (pagination.page - 1) * pagination.limit;

    const [events, total] = await Promise.all([
      Event.find(query)
        .populate(LIST_POPULATE)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pagination.limit)
        .exec(),
      Event.countDocuments(query)
    ]);

    return { events: await withInvitationCounts(events), total };
  }

  // Admin-wide listing, optionally narrowed to one organizer
  async findAll(
    filter: EventFilter & { organizerId?: string },
    pagination: Pagination
  ): Promise<{ events: IEvent[]; total: number }> {
    const query: any = {};
    if (filter.organizerId) query.organizerId = filter.organizerId;
    if (filter.status) query.status = filter.status;
    if (filter.categoryId) query.categoryId = filter.categoryId;

    const skip = (pagination.page - 1) * pagination.limit;

    const [events, total] = await Promise.all([
      Event.find(query)
        .populate(LIST_POPULATE)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pagination.limit)
        .exec(),
      Event.countDocuments(query)
    ]);

    return { events: await withInvitationCounts(events), total };
  }

  async findByIdAndOrganizer(eventId: string, organizerId: string | mongoose.Types.ObjectId): Promise<IEvent | null> {
    return await Event.findOne({ _id: eventId, organizerId }).exec();
  }

  async updateByIdAndOrganizer(eventId: string, organizerId: string | mongoose.Types.ObjectId, updateData: Partial<IEvent>): Promise<IEvent | null> {
    return await Event.findOneAndUpdate(
      { _id: eventId, organizerId },
      { $set: updateData },
      { new: true, runValidators: true }
    ).exec();
  }

  async softDeleteByIdAndOrganizer(eventId: string, organizerId: string | mongoose.Types.ObjectId): Promise<IEvent | null> {
    return await Event.findOneAndUpdate(
      { _id: eventId, organizerId },
      { $set: { status: EventStatus.CANCELLED } },
      { new: true }
    ).exec();
  }
}

// List rows show the organisation, category and whether invitations went out
const LIST_POPULATE = [
  { path: 'organizerId', select: 'fullName email profile.organizationName profile.logoKey' },
  { path: 'categoryId', select: 'name subcategories' }
];

// Number of invitees per event who were sent an invitation (or a send was attempted)
async function withInvitationCounts(events: IEvent[]): Promise<any[]> {
  if (events.length === 0) return [];
  const counts = await Invitee.aggregate([
    { $match: { eventId: { $in: events.map((e) => e._id) }, invitationStatus: { $ne: 'PENDING' } } },
    { $group: { _id: '$eventId', count: { $sum: 1 } } }
  ]);
  const byEvent = new Map(counts.map((c) => [String(c._id), c.count as number]));
  return events.map((e) => {
    const json: any = e.toJSON();
    const category: any = json.categoryId;
    if (json.subcategoryId && category && Array.isArray(category.subcategories)) {
      const sub = category.subcategories.find((x: any) => String(x._id) === String(json.subcategoryId));
      if (sub) json.subcategory = { _id: sub._id, name: sub.name };
    }
    if (category) delete category.subcategories;
    json.invitationsSent = byEvent.get(String(e._id)) || 0;
    return json;
  });
}

export const eventRepository = new EventRepository();
