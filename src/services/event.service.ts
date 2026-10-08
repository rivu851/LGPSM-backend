import { eventRepository, EventFilter, Pagination } from '../repositories/event.repository';
import { IEvent, Event, EventStatus } from '../models/Event';
import { Category } from '../models/Category';
import { Template } from '../models/Template';
import { Session } from '../models/Session';
import { Invitee } from '../models/Invitee';
import { Invitation } from '../models/Invitation';
import { CheckIn } from '../models/CheckIn';
import { SystemUserAssignment } from '../models/SystemUserAssignment';
import { Role } from '../models/User';
import mongoose from 'mongoose';
import { findManageableEvent } from '../utils/eventAccess';
import { platformSettingsService } from './platformSettings.service';
import { alertService } from './alert.service';
import { formatCardDate, formatCardTime } from '../utils/invitationContent';

export class EventService {
  /**
   * Creates a new event for an organizer.
   *
   * Rate Locking & Pricing Business Rule:
   * - When an event is created, `platformSettingsService.currentRateSnapshot()` captures the global
   *   per-invitee price rate in effect at that moment.
   * - This rate (`pricing.lockedRatePerInvitee`) is permanently locked to the event.
   * - Subsequent changes to the platform's global price rate (by Super Admin) do NOT modify existing
   *   or historical event rates.
   */
  async createEvent(organizerId: string, eventData: any): Promise<IEvent> {
    // Resolve Category
    let categoryId = eventData.categoryId;
    let categoryExists = categoryId && mongoose.Types.ObjectId.isValid(categoryId) 
      ? await Category.findById(categoryId) 
      : null;

    if (categoryId && !categoryExists) {
      const err: any = new Error('CATEGORY_NOT_FOUND');
      err.statusCode = 400;
      throw err;
    }

    if (!categoryExists) {
      let defaultCat = await Category.findOne({ name: 'General' });
      if (!defaultCat) {
        defaultCat = await Category.create({ name: 'General', isActive: true });
      }
      categoryId = defaultCat?._id;
    }

    // Validate Template if provided
    if (eventData.templateId && mongoose.Types.ObjectId.isValid(eventData.templateId)) {
      const templateExists = await Template.findById(eventData.templateId);
      if (!templateExists) {
        delete eventData.templateId;
      }
    } else {
      delete eventData.templateId;
    }

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);

    const startVal = eventData.schedule?.start || eventData.startDate || now;
    const endVal = eventData.schedule?.end || eventData.endDate || tomorrow;

    // Admin event settings apply on the server too
    await platformSettingsService.applyEventFeatureRules(eventData, true);

    // Resolve target organizer ID from eventData.organizerId or organizerId argument
    const targetOrganizer = (eventData.organizerId && mongoose.Types.ObjectId.isValid(eventData.organizerId))
      ? eventData.organizerId
      : organizerId;

    // Force organizerId and default status to PUBLISHED so it shows on event listing
    const dataToCreate = {
      ...eventData,
      categoryId,
      description: eventData.description || eventData.title || 'Event Description',
      format: eventData.format || 'PHYSICAL',
      schedule: {
        start: new Date(startVal),
        end: new Date(endVal)
      },
      organizerId: new mongoose.Types.ObjectId(targetOrganizer),
      status: 'PUBLISHED',
      // The per-invitee rate in force now is locked on the event; later rate changes do not affect it
      pricing: await platformSettingsService.currentRateSnapshot()
    };

    const created = await eventRepository.create(dataToCreate);
    await alertService.notifyAdmins('newEventAdded', {
      type: 'EVENT',
      title: 'New event added',
      message: created.schedule?.start
        ? `"${created.title}" was created and starts ${formatCardDate(new Date(created.schedule.start))}, ${formatCardTime(new Date(created.schedule.start))}.`
        : `"${created.title}" was created.`,
      entityType: 'Event',
      entityId: created._id
    });
    return created;
  }

  async getEventsByOrganizer(organizerId: string, filter: EventFilter & { organizerId?: string }, pagination: Pagination, role?: Role) {
    // Admins can review every organizer's events (read-only); organizers only see their own
    if (role === Role.ADMIN) {
      return await eventRepository.findAll(filter, pagination);
    }
    return await eventRepository.findByOrganizer(organizerId, filter, pagination);
  }

  async getEventById(eventId: string, organizerId: string, role?: Role): Promise<IEvent> {
    const event = role === Role.ADMIN
      ? await Event.findById(eventId).populate('organizerId', 'fullName email')
      : await findManageableEvent(eventId, organizerId, role);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }
    return event;
  }

  // Read model for detail screens: resolves the related category, subcategory and template for display
  async getEventDetails(eventId: string, organizerId: string, role?: Role) {
    const event = await this.getEventById(eventId, organizerId, role);
    await event.populate([
      { path: 'categoryId', select: 'name subcategories' },
      { path: 'templateId', select: 'name previewImageKey isActive' },
      { path: 'organizerId', select: 'fullName email profile.organizationName profile.logoKey' },
    ]);
    const json: any = event.toJSON();
    // subcategoryId references an embedded subcategory of the category; expose its name alongside the id
    const category: any = json.categoryId;
    if (json.subcategoryId && category && Array.isArray(category.subcategories)) {
      const sub = category.subcategories.find((s: any) => String(s._id) === String(json.subcategoryId));
      if (sub) json.subcategory = { _id: sub._id, name: sub.name };
    }
    if (category && typeof category === 'object') delete category.subcategories;
    return json;
  }

  async updateEvent(eventId: string, organizerId: string, updateData: any, role?: string): Promise<IEvent> {
    const existingEvent = await findManageableEvent(eventId, organizerId, role);
    if (!existingEvent) throw new Error('EVENT_NOT_FOUND');

    // Validate references if they are being updated
    if (updateData.categoryId && updateData.categoryId !== existingEvent.categoryId.toString()) {
      const categoryExists = await Category.findById(updateData.categoryId);
      if (!categoryExists) throw new Error('CATEGORY_NOT_FOUND');
    }

    if (updateData.templateId && updateData.templateId !== existingEvent.templateId?.toString()) {
      const templateExists = await Template.findById(updateData.templateId);
      if (!templateExists) throw new Error('TEMPLATE_NOT_FOUND');
    }

    // Disallow updating organizerId, _id, createdAt and the locked rate
    delete updateData.organizerId;
    delete updateData._id;
    delete updateData.createdAt;
    delete updateData.pricing;
    await platformSettingsService.applyEventFeatureRules(updateData);

    const updatedEvent = await eventRepository.updateByIdAndOrganizer(eventId, existingEvent.organizerId, updateData);
    if (!updatedEvent) {
      throw new Error('UPDATE_FAILED');
    }
    
    return updatedEvent;
  }

  async deactivateEvent(eventId: string, organizerId: string, role?: string): Promise<IEvent> {
    const existing = await findManageableEvent(eventId, organizerId, role);
    if (!existing) throw new Error('EVENT_NOT_FOUND');

    const deletedEvent = await eventRepository.softDeleteByIdAndOrganizer(eventId, String(existing.organizerId));
    if (!deletedEvent) {
      throw new Error('DELETION_FAILED');
    }
    return deletedEvent;
  }

  async cleanupEventOperationalData(eventId: string, actor: { userId: string; role: Role }): Promise<any> {
    // 1. Authorization: Only ADMIN
    if (actor.role !== Role.ADMIN) {
      throw new Error('FORBIDDEN_CLEANUP');
    }

    // 2. Fetch Event
    const event = await Event.findById(eventId);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    // 3. Idempotency: If already cleared
    if (event.operationalDataCleared) {
      return {
        event,
        alreadyCleared: true,
        cleanedCounts: { sessions: 0, invitees: 0, invitations: 0, checkIns: 0, assignments: 0 }
      };
    }

    // 4. Validate Event Has Ended
    const now = new Date();
    const endDate = event.schedule?.end ? new Date(event.schedule.end) : null;
    const isEnded = (endDate && now > endDate) || event.status === EventStatus.COMPLETED;

    if (!isEnded) {
      throw new Error('EVENT_NOT_ENDED');
    }

    // 5. Atomic Deletion of Event-Specific Operational Data
    // DO NOT DELETE GLOBAL USERS (User model)!
    const eventObjId = new mongoose.Types.ObjectId(eventId);

    const [sessionRes, inviteeRes, invitationRes, checkInRes, assignmentRes] = await Promise.all([
      Session.deleteMany({ eventId: eventObjId }),
      Invitee.deleteMany({ eventId: eventObjId }),
      Invitation.deleteMany({ eventId: eventObjId }),
      CheckIn.deleteMany({ eventId: eventObjId }),
      SystemUserAssignment.deleteMany({ eventId: eventObjId }),
    ]);

    event.operationalDataCleared = true;
    event.status = EventStatus.COMPLETED;
    await event.save();

    return {
      event,
      alreadyCleared: false,
      cleanedCounts: {
        sessions: sessionRes.deletedCount || 0,
        invitees: inviteeRes.deletedCount || 0,
        invitations: invitationRes.deletedCount || 0,
        checkIns: checkInRes.deletedCount || 0,
        assignments: assignmentRes.deletedCount || 0,
      }
    };
  }
}

export const eventService = new EventService();
