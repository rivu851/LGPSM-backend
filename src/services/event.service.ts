import { eventRepository, EventFilter, Pagination } from '../repositories/event.repository';
import { IEvent, Event, EventStatus } from '../models/Event';
import { Category } from '../models/Category';
import { templateService } from './template.service';
import { Session } from '../models/Session';
import { Invitee } from '../models/Invitee';
import { Invitation, InvitationDeliveryStatus } from '../models/Invitation';
import { CheckIn } from '../models/CheckIn';
import { SystemUserAssignment } from '../models/SystemUserAssignment';
import { Role } from '../models/User';
import mongoose from 'mongoose';
import { findManageableEvent } from '../utils/eventAccess';
import { platformSettingsService } from './platformSettings.service';
import { alertService } from './alert.service';
import { validateAdmissionInput } from '../utils/admissionWindow';
import { canTransition } from '../utils/eventLifecycle';
import { formatCardDate, formatCardTime } from '../utils/invitationContent';

// Client-writable event fields. Anything else in a request body (organizerId, status flags,
// operationalDataCleared, pricing, ...) is server-controlled and is dropped before it reaches the database.
const EVENT_WRITABLE_FIELDS = [
  'title', 'description', 'categoryId', 'subcategoryId', 'format', 'location', 'contactNumber',
  'schedule', 'admission', 'rsvp', 'attendeeSettings', 'dietaryPreference', 'templateId', 'cardInfo', 'media'
] as const;
/**
 * Clients send a pin as [longitude, latitude]; the database keeps a GeoJSON Point (which the 2dsphere index needs).
 * Anything that is not a real coordinate pair is dropped, so a bad value can never reach the index.
 */
export function normalizeLocation(location: any) {
  if (!location || typeof location !== 'object' || Array.isArray(location)) return location;
  const { coordinates, ...rest } = location;
  const pair = Array.isArray(coordinates) ? coordinates : coordinates?.type === 'Point' ? coordinates.coordinates : null;
  const valid = Array.isArray(pair) && pair.length === 2 && pair.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
    && Math.abs(pair[0]) <= 180 && Math.abs(pair[1]) <= 90;
  return valid ? { ...rest, coordinates: { type: 'Point', coordinates: [pair[0], pair[1]] } } : rest;
}

const pickEventFields = (data: any, extra: readonly string[] = []) => {
  const out: Record<string, any> = {};
  for (const key of [...EVENT_WRITABLE_FIELDS, ...extra]) {
    if (data && data[key] !== undefined) out[key] = data[key];
  }
  if (out.location !== undefined) out.location = normalizeLocation(out.location);
  return out;
};

export class EventService {
  /** True once any invitation for the event was sent or attempted (the event is locked from then on). */
  async invitationsStarted(eventId: string | mongoose.Types.ObjectId): Promise<boolean> {
    return !!(await Invitation.exists({ eventId, status: { $in: [InvitationDeliveryStatus.SENT, InvitationDeliveryStatus.FAILED] } }));
  }

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
  async createEvent(organizerId: string, rawEventData: any): Promise<IEvent> {
    // The owner is always the authenticated caller (or, for admins, the id the controller passes in)
    const eventData: any = pickEventFields(rawEventData, ['startDate', 'endDate']);
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
      // a template another organizer owns is treated like a missing one
      if (!(await templateService.isUsableByOrganizer(String(eventData.templateId), String(organizerId)))) {
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

    const targetOrganizer = organizerId;

    const admissionError = validateAdmissionInput({ start: new Date(startVal), end: new Date(endVal) }, eventData.admission);
    if (admissionError) throw { statusCode: 400, message: admissionError };

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

  async updateEvent(eventId: string, organizerId: string, rawUpdateData: any, role?: string): Promise<IEvent> {
    const updateData: any = pickEventFields(rawUpdateData);
    const existingEvent = await findManageableEvent(eventId, organizerId, role);
    if (!existingEvent) throw new Error('EVENT_NOT_FOUND');
    // A closed or cancelled event is a historical record
    if (existingEvent.status === EventStatus.COMPLETED || existingEvent.status === EventStatus.CANCELLED) throw new Error('EVENT_CLOSED');
    // Feedback 14: once invitations have gone out (or were attempted), neither the organizer nor an admin can edit
    // the event, so guests' cards and passes always match what was sent. The web edit form applies the same rule.
    if (await this.invitationsStarted(existingEvent._id as any)) throw new Error('EVENT_LOCKED');

    // Validate references if they are being updated
    if (updateData.categoryId && updateData.categoryId !== existingEvent.categoryId.toString()) {
      const categoryExists = await Category.findById(updateData.categoryId);
      if (!categoryExists) throw new Error('CATEGORY_NOT_FOUND');
    }

    if (updateData.templateId && updateData.templateId !== existingEvent.templateId?.toString()) {
      if (!(await templateService.isUsableByOrganizer(String(updateData.templateId), String(existingEvent.organizerId)))) throw new Error('TEMPLATE_NOT_FOUND');
    }

    // The check-in window is validated against the schedule that will be in force after this update
    if (updateData.admission !== undefined || updateData.schedule) {
      const admissionError = validateAdmissionInput(
        { start: updateData.schedule?.start ?? existingEvent.schedule?.start, end: updateData.schedule?.end ?? existingEvent.schedule?.end },
        updateData.admission !== undefined ? updateData.admission : (existingEvent as any).admission
      );
      if (admissionError) throw { statusCode: 400, message: admissionError };
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

  /**
   * Change only the check-in window. Unlike a general edit this is allowed after invitations went out: the window is
   * not printed on any card or pass, so changing it cannot make what guests received wrong, and organizers need to be
   * able to open earlier or extend on the day. Only a PUBLISHED event can be changed; the route audits it.
   */
  async updateAdmission(eventId: string, actor: { userId: string; role: Role }, admission: { opensAt?: string | null; closesAt?: string | null }): Promise<IEvent> {
    if (actor.role !== Role.ADMIN && actor.role !== Role.ORGANIZER) throw new Error('FORBIDDEN');
    const event = await findManageableEvent(eventId, actor.userId, actor.role);
    if (!event) throw new Error('EVENT_NOT_FOUND');
    if (event.status !== EventStatus.PUBLISHED) throw new Error('EVENT_CLOSED');

    // Merge over what is stored so a request may change one side only; null returns that side to its default
    const current: any = (event as any).admission || {};
    const next = {
      opensAt: admission.opensAt !== undefined ? admission.opensAt : current.opensAt ?? null,
      closesAt: admission.closesAt !== undefined ? admission.closesAt : current.closesAt ?? null
    };
    const admissionError = validateAdmissionInput(event.schedule, next);
    if (admissionError) throw { statusCode: 400, message: admissionError };

    const updated = await Event.findOneAndUpdate(
      { _id: event._id, status: EventStatus.PUBLISHED },
      { $set: { admission: { opensAt: next.opensAt ? new Date(next.opensAt as any) : null, closesAt: next.closesAt ? new Date(next.closesAt as any) : null } } },
      { new: true }
    );
    if (!updated) throw new Error('EVENT_CLOSED');
    return updated;
  }

  async deactivateEvent(eventId: string, organizerId: string, role?: string): Promise<IEvent> {
    const existing = await findManageableEvent(eventId, organizerId, role);
    if (!existing) throw new Error('EVENT_NOT_FOUND');
    if (existing.status === EventStatus.CANCELLED) return existing; // already cancelled: nothing to change
    if (!canTransition(existing.status, EventStatus.CANCELLED)) throw new Error('INVALID_TRANSITION');

    const deletedEvent = await eventRepository.softDeleteByIdAndOrganizer(eventId, String(existing.organizerId));
    if (!deletedEvent) {
      throw new Error('DELETION_FAILED');
    }
    return deletedEvent;
  }

  /**
   * Non-destructive close: PUBLISHED -> COMPLETED. Nothing is deleted; sessions, invitees, invitations, RSVPs,
   * check-ins, assignments, reports and audit entries all stay available. Admin may close any event, an organizer
   * only their own.
   */
  async closeEvent(eventId: string, actor: { userId: string; role: Role }): Promise<IEvent> {
    if (actor.role !== Role.ADMIN && actor.role !== Role.ORGANIZER) throw new Error('FORBIDDEN_CLOSE');
    const event = await findManageableEvent(eventId, actor.userId, actor.role);
    if (!event) throw new Error('EVENT_NOT_FOUND');
    if (!canTransition(event.status, EventStatus.COMPLETED)) throw new Error('INVALID_TRANSITION');

    // Conditional update so two concurrent closes (or a close racing a cancel) cannot both win
    const closed = await Event.findOneAndUpdate(
      { _id: event._id, status: EventStatus.PUBLISHED },
      { $set: { status: EventStatus.COMPLETED, closedAt: new Date(), closedBy: new mongoose.Types.ObjectId(actor.userId) } },
      { new: true }
    );
    if (!closed) throw new Error('INVALID_TRANSITION');
    return closed;
  }

  /**
   * PERMANENT deletion of an event's operational data (admin only, irreversible). It is a separate operation from
   * closing: the event must already have been closed (COMPLETED), the caller must retype the event title, and the
   * event record itself is kept so reports of what existed remain attributable.
   */
  async cleanupEventOperationalData(eventId: string, actor: { userId: string; role: Role }, confirmTitle?: string): Promise<any> {
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

    // 4. Only an event that was explicitly closed can be purged; being past its end date is not enough
    if (event.status !== EventStatus.COMPLETED) {
      throw new Error('EVENT_NOT_CLOSED');
    }
    if (!confirmTitle || confirmTitle.trim() !== String(event.title).trim()) {
      throw new Error('CONFIRMATION_REQUIRED');
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
