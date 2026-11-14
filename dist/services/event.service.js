"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventService = exports.EventService = void 0;
exports.normalizeLocation = normalizeLocation;
const category_service_1 = require("./category.service");
const event_repository_1 = require("../repositories/event.repository");
const Event_1 = require("../models/Event");
const Category_1 = require("../models/Category");
const template_service_1 = require("./template.service");
const Session_1 = require("../models/Session");
const Invitee_1 = require("../models/Invitee");
const Invitation_1 = require("../models/Invitation");
const CheckIn_1 = require("../models/CheckIn");
const SystemUserAssignment_1 = require("../models/SystemUserAssignment");
const User_1 = require("../models/User");
const mongoose_1 = __importDefault(require("mongoose"));
const eventAccess_1 = require("../utils/eventAccess");
const platformSettings_service_1 = require("./platformSettings.service");
const alert_service_1 = require("./alert.service");
const cancellationNotice_service_1 = require("./cancellationNotice.service");
const admissionWindow_1 = require("../utils/admissionWindow");
const eventLifecycle_1 = require("../utils/eventLifecycle");
const invitationContent_1 = require("../utils/invitationContent");
const User_2 = require("../models/User");
const CredentialEvent_1 = require("../models/CredentialEvent");
const PassNotice_1 = require("../models/PassNotice");
const CancellationNotice_1 = require("../models/CancellationNotice");
const InviteeSet_1 = require("../models/InviteeSet");
const Notification_1 = require("../models/Notification");
const Media_1 = require("../models/Media");
// Client-writable event fields. Anything else in a request body (organizerId, status flags,
// operationalDataCleared, pricing, ...) is server-controlled and is dropped before it reaches the database.
const EVENT_WRITABLE_FIELDS = [
    'title', 'description', 'categoryId', 'subcategoryId', 'format', 'location', 'contactNumber',
    'schedule', 'admission', 'rsvp', 'attendeeSettings', 'dietaryPreference', 'templateId', 'cardInfo', 'cardDisplay', 'media'
];
/**
 * Clients send a pin as [longitude, latitude]; the database keeps a GeoJSON Point (which the 2dsphere index needs).
 * Anything that is not a real coordinate pair is dropped, so a bad value can never reach the index.
 */
function normalizeLocation(location) {
    if (!location || typeof location !== 'object' || Array.isArray(location))
        return location;
    const { coordinates, ...rest } = location;
    const pair = Array.isArray(coordinates) ? coordinates : coordinates?.type === 'Point' ? coordinates.coordinates : null;
    const valid = Array.isArray(pair) && pair.length === 2 && pair.every((n) => typeof n === 'number' && Number.isFinite(n))
        && Math.abs(pair[0]) <= 180 && Math.abs(pair[1]) <= 90;
    return valid ? { ...rest, coordinates: { type: 'Point', coordinates: [pair[0], pair[1]] } } : rest;
}
const pickEventFields = (data, extra = []) => {
    const out = {};
    for (const key of [...EVENT_WRITABLE_FIELDS, ...extra]) {
        if (data && data[key] !== undefined)
            out[key] = data[key];
    }
    if (out.location !== undefined)
        out.location = normalizeLocation(out.location);
    return out;
};
class EventService {
    /** True once any invitation for the event was sent or attempted (the event is locked from then on). */
    async invitationsStarted(eventId) {
        return !!(await Invitation_1.Invitation.exists({ eventId, status: { $in: [Invitation_1.InvitationDeliveryStatus.SENT, Invitation_1.InvitationDeliveryStatus.FAILED] } }));
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
    async createEvent(organizerId, rawEventData, adminActorId) {
        // The owner is always the authenticated caller (or, for admins, the id the controller passes in)
        const eventData = pickEventFields(rawEventData, ['startDate', 'endDate']);
        // Resolve Category
        let categoryId = eventData.categoryId;
        let categoryExists = categoryId && mongoose_1.default.Types.ObjectId.isValid(categoryId)
            ? await Category_1.Category.findById(categoryId)
            : null;
        // another organizer's custom category is treated as missing
        if (categoryExists && !(await (0, category_service_1.canUseCategory)(String(categoryId), eventData.subcategoryId ? String(eventData.subcategoryId) : undefined, String(organizerId))))
            categoryExists = null;
        if (categoryId && !categoryExists) {
            const err = new Error('CATEGORY_NOT_FOUND');
            err.statusCode = 400;
            throw err;
        }
        if (!categoryExists) {
            // the platform's own General, never an organizer's private category that happens to share the name
            let defaultCat = await Category_1.Category.findOne({ name: 'General', ownerId: null });
            if (!defaultCat) {
                defaultCat = await Category_1.Category.create({ name: 'General', isActive: true });
            }
            categoryId = defaultCat?._id;
        }
        // Validate Template if provided
        if (eventData.templateId && mongoose_1.default.Types.ObjectId.isValid(eventData.templateId)) {
            // a template another organizer owns is treated like a missing one
            if (!(await template_service_1.templateService.isUsableByOrganizer(String(eventData.templateId), String(organizerId)))) {
                // An admin creating this event for an organizer may have picked a design they uploaded themselves: the organizer gets their own copy
                const copyId = adminActorId ? await template_service_1.templateService.copyOwnTemplateFor(String(eventData.templateId), adminActorId, String(organizerId)) : null;
                if (copyId)
                    eventData.templateId = copyId;
                else
                    delete eventData.templateId;
            }
        }
        else {
            delete eventData.templateId;
        }
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 86400000);
        const startVal = eventData.schedule?.start || eventData.startDate || now;
        const endVal = eventData.schedule?.end || eventData.endDate || tomorrow;
        const startAt = new Date(startVal), endAt = new Date(endVal);
        if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()))
            throw { statusCode: 400, message: 'Enter a valid start and end date.' };
        if (endAt.getTime() <= startAt.getTime())
            throw { statusCode: 400, message: 'The event must end after it starts.' };
        // Admin event settings apply on the server too
        await platformSettings_service_1.platformSettingsService.applyEventFeatureRules(eventData, true);
        const targetOrganizer = organizerId;
        const admissionError = (0, admissionWindow_1.validateAdmissionInput)({ start: new Date(startVal), end: new Date(endVal) }, eventData.admission);
        if (admissionError)
            throw { statusCode: 400, message: admissionError };
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
            organizerId: new mongoose_1.default.Types.ObjectId(targetOrganizer),
            status: 'PUBLISHED',
            // The per-invitee rate in force now is locked on the event; later rate changes do not affect it
            pricing: await platformSettings_service_1.platformSettingsService.currentRateSnapshot()
        };
        const created = await event_repository_1.eventRepository.create(dataToCreate);
        await alert_service_1.alertService.notifyAdmins('newEventAdded', {
            type: 'EVENT',
            title: 'New event added',
            message: created.schedule?.start
                ? `"${created.title}" was created and starts ${(0, invitationContent_1.formatCardDate)(new Date(created.schedule.start))}, ${(0, invitationContent_1.formatCardTime)(new Date(created.schedule.start))}.`
                : `"${created.title}" was created.`,
            entityType: 'Event',
            entityId: created._id
        });
        // an administrator created it on the organizer's behalf: the organizer is told
        if (adminActorId && String(adminActorId) !== String(targetOrganizer)) {
            await alert_service_1.alertService.notifyUser(targetOrganizer, {
                type: 'EVENT',
                title: 'An administrator created an event for you',
                message: `"${created.title}" was created for you by an administrator. Open it to see the details, add invitees and send the invitations.`,
                entityType: 'Event',
                entityId: created._id
            });
        }
        return created;
    }
    /** The accounts an admin may create an event for: real, active organizers. Checked before anything is created. */
    async resolveOrganizerTargets(ids) {
        const unique = [...new Set(ids.map(String))];
        const refuse = { statusCode: 400, message: 'Choose active organizers for this event.' };
        if (unique.length === 0 || unique.length > 200 || unique.some((id) => !/^[0-9a-fA-F]{24}$/.test(id)))
            throw refuse;
        const found = await User_2.User.countDocuments({ _id: { $in: unique }, role: User_1.Role.ORGANIZER, isActive: true });
        if (found !== unique.length)
            throw refuse;
        return unique;
    }
    async getEventsByOrganizer(organizerId, filter, pagination, role) {
        // Admins can review every organizer's events (read-only); organizers only see their own
        if (role === User_1.Role.ADMIN) {
            return await event_repository_1.eventRepository.findAll(filter, pagination);
        }
        return await event_repository_1.eventRepository.findByOrganizer(organizerId, filter, pagination);
    }
    async getEventById(eventId, organizerId, role) {
        const event = role === User_1.Role.ADMIN
            ? await Event_1.Event.findById(eventId).populate('organizerId', 'fullName email')
            : await (0, eventAccess_1.findManageableEvent)(eventId, organizerId, role);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        return event;
    }
    // The three numbers on an event's tab strip (sessions, invitees, assigned staff) in one request, instead of three list calls.
    // Each count matches what the corresponding list reports: the Invitee model already leaves set-aside guests out of counts.
    async getEventCounts(eventId, organizerId, role) {
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, organizerId, role);
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        const [sessions, invitees, assignments] = await Promise.all([
            Session_1.Session.countDocuments({ eventId }),
            Invitee_1.Invitee.countDocuments({ eventId }),
            SystemUserAssignment_1.SystemUserAssignment.countDocuments({ eventId }),
        ]);
        return { sessions, invitees, assignments };
    }
    // Read model for detail screens: resolves the related category, subcategory and template for display
    async getEventDetails(eventId, organizerId, role) {
        const event = await this.getEventById(eventId, organizerId, role);
        await event.populate([
            { path: 'categoryId', select: 'name subcategories ownerId' },
            { path: 'templateId', select: 'name previewImageKey isActive templateData' },
            { path: 'organizerId', select: 'fullName email profile.organizationName profile.logoKey profile.invitationChannel' },
        ]);
        const json = event.toJSON();
        // subcategoryId references an embedded subcategory of the category; expose its name alongside the id
        const category = json.categoryId;
        if (json.subcategoryId && category && Array.isArray(category.subcategories)) {
            const sub = category.subcategories.find((s) => String(s._id) === String(json.subcategoryId));
            if (sub)
                json.subcategory = { _id: sub._id, name: sub.name, isCustom: !!sub.ownerId };
        }
        if (category && typeof category === 'object')
            delete category.subcategories;
        return json;
    }
    async updateEvent(eventId, organizerId, rawUpdateData, role, expectedUpdatedAt) {
        const updateData = pickEventFields(rawUpdateData);
        const existingEvent = await (0, eventAccess_1.findManageableEvent)(eventId, organizerId, role);
        if (!existingEvent)
            throw new Error('EVENT_NOT_FOUND');
        // A closed or cancelled event is a historical record
        if (existingEvent.status === Event_1.EventStatus.COMPLETED || existingEvent.status === Event_1.EventStatus.CANCELLED)
            throw new Error('EVENT_CLOSED');
        // Feedback 14: once invitations have gone out (or were attempted), neither the organizer nor an admin can edit
        // the event, so guests' cards and passes always match what was sent. The web edit form applies the same rule.
        if (await this.invitationsStarted(existingEvent._id))
            throw new Error('EVENT_LOCKED');
        // The editor opened a version of the event; if someone has saved it since, this edit would silently overwrite their change
        const staleCheck = () => { throw Object.assign(new Error('EVENT_EDIT_CONFLICT'), { currentVersion: existingEvent.updatedAt }); };
        if (expectedUpdatedAt && new Date(existingEvent.updatedAt).getTime() !== expectedUpdatedAt.getTime())
            staleCheck();
        // Validate references if they are being updated
        const categoryChanged = !!updateData.categoryId && updateData.categoryId !== existingEvent.categoryId?.toString();
        const subcategoryChanged = !!updateData.subcategoryId && updateData.subcategoryId !== existingEvent.subcategoryId?.toString();
        if (categoryChanged || subcategoryChanged) {
            // judged for the event's owner, whoever is editing: another organizer's custom category or subcategory counts as missing
            const nextCategoryId = String(updateData.categoryId || existingEvent.categoryId);
            const categoryExists = await Category_1.Category.findById(nextCategoryId);
            if (!categoryExists || !(await (0, category_service_1.canUseCategory)(nextCategoryId, updateData.subcategoryId ? String(updateData.subcategoryId) : undefined, String(existingEvent.organizerId))))
                throw new Error('CATEGORY_NOT_FOUND');
        }
        if (updateData.templateId && updateData.templateId !== existingEvent.templateId?.toString()) {
            if (!(await template_service_1.templateService.isUsableByOrganizer(String(updateData.templateId), String(existingEvent.organizerId)))) {
                // An admin editing an organizer's event may pick a design they uploaded themselves: the organizer gets their own copy
                const copyId = role === User_1.Role.ADMIN ? await template_service_1.templateService.copyOwnTemplateFor(String(updateData.templateId), organizerId, String(existingEvent.organizerId)) : null;
                if (!copyId)
                    throw new Error('TEMPLATE_NOT_FOUND');
                updateData.templateId = copyId;
            }
        }
        // The check-in window is validated against the schedule that will be in force after this update
        if (updateData.admission !== undefined || updateData.schedule) {
            const admissionError = (0, admissionWindow_1.validateAdmissionInput)({ start: updateData.schedule?.start ?? existingEvent.schedule?.start, end: updateData.schedule?.end ?? existingEvent.schedule?.end }, updateData.admission !== undefined ? updateData.admission : existingEvent.admission);
            if (admissionError)
                throw { statusCode: 400, message: admissionError };
        }
        // An event cannot start before it was created, and must end after both its start and its creation
        if (updateData.schedule) {
            const created = existingEvent.createdAt ? new Date(existingEvent.createdAt).getTime() : NaN;
            const startMs = new Date(updateData.schedule.start ?? existingEvent.schedule?.start).getTime();
            const endMs = new Date(updateData.schedule.end ?? existingEvent.schedule?.end).getTime();
            if (!Number.isNaN(created) && !Number.isNaN(startMs) && startMs < created)
                throw { statusCode: 400, message: 'The event cannot start before it was created.' };
            if (!Number.isNaN(created) && !Number.isNaN(endMs) && endMs <= created)
                throw { statusCode: 400, message: 'The event must end after it was created.' };
            if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs <= startMs)
                throw { statusCode: 400, message: 'The event must end after it starts.' };
        }
        // Disallow updating organizerId, _id, createdAt and the locked rate
        delete updateData.organizerId;
        delete updateData._id;
        delete updateData.createdAt;
        delete updateData.pricing;
        await platformSettings_service_1.platformSettingsService.applyEventFeatureRules(updateData);
        const updatedEvent = await event_repository_1.eventRepository.updateByIdAndOrganizer(eventId, existingEvent.organizerId, updateData, expectedUpdatedAt);
        if (!updatedEvent) {
            // the version check is part of the update itself, so a save that lost the race to another one lands here
            if (expectedUpdatedAt) {
                const latest = await Event_1.Event.findById(eventId).select('updatedAt').lean();
                if (latest && latest.updatedAt && new Date(latest.updatedAt).getTime() !== expectedUpdatedAt.getTime())
                    throw Object.assign(new Error('EVENT_EDIT_CONFLICT'), { currentVersion: latest.updatedAt });
            }
            throw new Error('UPDATE_FAILED');
        }
        // an administrator changed the organizer's event: the organizer is told which event
        if (role === User_1.Role.ADMIN && String(existingEvent.organizerId) !== String(organizerId)) {
            await alert_service_1.alertService.notifyUser(existingEvent.organizerId, {
                type: 'EVENT',
                title: 'An administrator updated your event',
                message: `"${updatedEvent.title}" was changed by an administrator. Open the event to review the changes.`,
                entityType: 'Event',
                entityId: updatedEvent._id
            });
        }
        return updatedEvent;
    }
    /**
     * Change only the check-in window. Unlike a general edit this is allowed after invitations went out: the window is
     * not printed on any card or pass, so changing it cannot make what guests received wrong, and organizers need to be
     * able to open earlier or extend on the day. Only a PUBLISHED event can be changed; the route audits it.
     */
    async updateAdmission(eventId, actor, admission) {
        if (actor.role !== User_1.Role.ADMIN && actor.role !== User_1.Role.ORGANIZER)
            throw new Error('FORBIDDEN');
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, actor.userId, actor.role);
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        if (event.status !== Event_1.EventStatus.PUBLISHED)
            throw new Error('EVENT_CLOSED');
        // Merge over what is stored so a request may change one side only; null returns that side to its default
        const current = event.admission || {};
        const next = {
            opensAt: admission.opensAt !== undefined ? admission.opensAt : current.opensAt ?? null,
            closesAt: admission.closesAt !== undefined ? admission.closesAt : current.closesAt ?? null
        };
        const admissionError = (0, admissionWindow_1.validateAdmissionInput)(event.schedule, next);
        if (admissionError)
            throw { statusCode: 400, message: admissionError };
        const updated = await Event_1.Event.findOneAndUpdate({ _id: event._id, status: Event_1.EventStatus.PUBLISHED }, { $set: { admission: { opensAt: next.opensAt ? new Date(next.opensAt) : null, closesAt: next.closesAt ? new Date(next.closesAt) : null } } }, { new: true });
        if (!updated)
            throw new Error('EVENT_CLOSED');
        return updated;
    }
    /**
     * Cancels an event. Terminal: nothing in the app can bring a cancelled event back (a replacement event must be
     * created instead). History is untouched; only the status changes and the guests who were invited are queued to be told.
     *
     * Idempotent: cancelling a cancelled event changes nothing and creates no second set of notices (enqueueing is
     * keyed on guest, so repeating it can only add notices that are genuinely missing).
     */
    async cancelEvent(eventId, actor, reason) {
        if (actor.role !== User_1.Role.ADMIN && actor.role !== User_1.Role.ORGANIZER)
            throw new Error('FORBIDDEN');
        const existing = await (0, eventAccess_1.findManageableEvent)(eventId, actor.userId, actor.role);
        if (!existing)
            throw new Error('EVENT_NOT_FOUND');
        if (existing.status === Event_1.EventStatus.COMPLETED)
            throw new Error('INVALID_TRANSITION');
        const cleanReason = typeof reason === 'string' ? reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) || undefined : undefined;
        let alreadyCancelled = existing.status === Event_1.EventStatus.CANCELLED;
        let event = existing;
        if (!alreadyCancelled) {
            // Conditional + atomic: the status, its metadata and the admission counter freeze change together, so a check-in
            // is either entirely before the cancellation or refused after it.
            const cancelled = await Event_1.Event.findOneAndUpdate({ _id: existing._id, status: { $in: [Event_1.EventStatus.PUBLISHED, Event_1.EventStatus.DRAFT] } }, [{ $set: {
                        status: Event_1.EventStatus.CANCELLED,
                        cancelledAt: new Date(),
                        cancelledBy: new mongoose_1.default.Types.ObjectId(actor.userId),
                        cancelledByRole: actor.role,
                        ...(cleanReason ? { cancellationReason: cleanReason } : {}),
                        finalAdmissionSeq: { $ifNull: ['$admissionSeq', 0] }
                    } }], { new: true, updatePipeline: true, timestamps: false });
            if (cancelled)
                event = cancelled;
            else {
                // lost a race with another cancel (fine) or with a close (not fine)
                const now = await Event_1.Event.findById(existing._id);
                if (!now)
                    throw new Error('EVENT_NOT_FOUND');
                if (now.status !== Event_1.EventStatus.CANCELLED)
                    throw new Error('INVALID_TRANSITION');
                alreadyCancelled = true;
                event = now;
            }
        }
        // who cancelled is told to the other side: the administrators when an organizer cancels, the organizer when an administrator does
        if (!alreadyCancelled) {
            const byAdmin = actor.role === User_1.Role.ADMIN;
            const content = {
                type: 'EVENT',
                title: 'Event cancelled',
                message: byAdmin
                    ? `"${event.title}" was cancelled by an administrator${cleanReason ? `: ${cleanReason}` : '.'}`
                    : `"${event.title}" was cancelled by its organizer${cleanReason ? `: ${cleanReason}` : '.'}`,
                entityType: 'Event',
                entityId: event._id
            };
            if (byAdmin)
                await alert_service_1.alertService.notifyUser(event.organizerId, content);
            else
                await alert_service_1.alertService.notifyAdmins('eventCancelled', content, { email: false });
        }
        // Stored first, sent afterwards: a provider outage can never undo or block the cancellation
        const queued = await cancellationNotice_service_1.cancellationNoticeService.enqueueForEvent(event);
        if (queued.eligible > 0) {
            cancellationNotice_service_1.cancellationNoticeService.processEvent(event._id).catch((e) => console.error('Cancellation notice dispatch failed:', e?.message));
        }
        return { event, alreadyCancelled, notices: queued };
    }
    /** The event, for reading or retrying its cancellation notices: admin or the owning organizer only (never staff). */
    async findForNotices(eventId, actor) {
        if (actor.role !== User_1.Role.ADMIN && actor.role !== User_1.Role.ORGANIZER)
            throw new Error('FORBIDDEN');
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, actor.userId, actor.role);
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        return event;
    }
    /**
     * Non-destructive close: PUBLISHED -> COMPLETED. Nothing is deleted; sessions, invitees, invitations, RSVPs,
     * check-ins, assignments, reports and audit entries all stay available. Admin may close any event, an organizer
     * only their own.
     */
    async closeEvent(eventId, actor) {
        if (actor.role !== User_1.Role.ADMIN && actor.role !== User_1.Role.ORGANIZER)
            throw new Error('FORBIDDEN_CLOSE');
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, actor.userId, actor.role);
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        if (!(0, eventLifecycle_1.canTransition)(event.status, Event_1.EventStatus.COMPLETED))
            throw new Error('INVALID_TRANSITION');
        // Conditional update so two concurrent closes (or a close racing a cancel) cannot both win
        // One atomic update that also freezes the admission counter: every admission writes the same document inside its
        // own transaction, so a check-in and this close are strictly ordered (see checkIn.service `commitAdmission`).
        const closed = await Event_1.Event.findOneAndUpdate({ _id: event._id, status: Event_1.EventStatus.PUBLISHED }, [{ $set: { status: Event_1.EventStatus.COMPLETED, closedAt: new Date(), closedBy: new mongoose_1.default.Types.ObjectId(actor.userId), finalAdmissionSeq: { $ifNull: ['$admissionSeq', 0] } } }], { new: true, updatePipeline: true, timestamps: false });
        if (!closed)
            throw new Error('INVALID_TRANSITION');
        return closed;
    }
    /**
     * PERMANENT deletion of an event's operational data (admin only, irreversible). It is a separate operation from
     * closing: the event must already be over (end time passed, or closed), the caller must retype the event title, and the
     * event record itself is kept so reports of what existed remain attributable.
     */
    /**
     * "Delete event" for an event that is over: the event itself and all of its data are removed for good (its guests, sessions,
     * invitations, check-ins, staff assignments, passes and notices, and its uploaded image). The owning organizer or an admin,
     * only after the event has ended, and only with the event title typed to confirm. The audit trail is kept, so who deleted
     * what stays on record.
     */
    async deleteEventPermanently(eventId, actor, confirmTitle) {
        if (actor.role !== User_1.Role.ADMIN && actor.role !== User_1.Role.ORGANIZER)
            throw new Error('EVENT_NOT_FOUND');
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, actor.userId, actor.role);
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        // past = closed, or its end time has passed (a cancelled event that is over counts too)
        const endAt = event.schedule?.end ? new Date(event.schedule.end).getTime() : NaN;
        const isPast = event.status === Event_1.EventStatus.COMPLETED || (!Number.isNaN(endAt) && endAt <= Date.now());
        if (!isPast)
            throw new Error('EVENT_NOT_CLOSED');
        if (!confirmTitle || confirmTitle.trim() !== String(event.title).trim())
            throw new Error('CONFIRMATION_REQUIRED');
        await purgeOperationalData(eventId);
        const logoKey = event.media?.logoKey;
        if (typeof logoKey === 'string' && /^media:[0-9a-fA-F]{24}$/.test(logoKey)) {
            await Media_1.Media.deleteOne({ _id: logoKey.slice(6), purpose: Media_1.MediaPurpose.EVENT_LOGO });
        }
        await Event_1.Event.deleteOne({ _id: event._id });
        return { title: String(event.title) };
    }
    async cleanupEventOperationalData(eventId, actor, confirmTitle) {
        // 1. Authorization: Only ADMIN
        if (actor.role !== User_1.Role.ADMIN) {
            throw new Error('FORBIDDEN_CLEANUP');
        }
        // 2. Fetch Event
        const event = await Event_1.Event.findById(eventId);
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
        // 4. Only an event that is over (its end time has passed, or it was closed) can be purged
        if (!(0, eventLifecycle_1.eventHasEnded)(event)) {
            throw new Error('EVENT_NOT_CLOSED');
        }
        if (!confirmTitle || confirmTitle.trim() !== String(event.title).trim()) {
            throw new Error('CONFIRMATION_REQUIRED');
        }
        // 5. Delete the event's operational data. Not a transaction (it can be far larger than one should be), so the "cleared" mark is
        // written last: an interrupted purge is finished by repeating it. Accounts and the audit trail are kept.
        const { sessionRes, inviteeRes, invitationRes, checkInRes, assignmentRes } = await purgeOperationalData(eventId);
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
exports.EventService = EventService;
/** Deletes everything an event's guests, sessions and passes are made of. Accounts and the audit trail are not touched. */
async function purgeOperationalData(eventId) {
    const eventObjId = new mongoose_1.default.Types.ObjectId(eventId);
    const [sessionRes, inviteeRes, invitationRes, checkInRes, assignmentRes] = await Promise.all([
        Session_1.Session.deleteMany({ eventId: eventObjId }),
        Invitee_1.Invitee.deleteMany({ eventId: eventObjId }).setOptions({ includeArchived: true }),
        Invitation_1.Invitation.deleteMany({ eventId: eventObjId }),
        CheckIn_1.CheckIn.deleteMany({ eventId: eventObjId }),
        SystemUserAssignment_1.SystemUserAssignment.deleteMany({ eventId: eventObjId }),
    ]);
    // Everything else that names the event's guests or their passes goes with them
    await Promise.all([
        CredentialEvent_1.CredentialEvent.deleteMany({ eventId: eventObjId }),
        PassNotice_1.PassNotice.deleteMany({ eventId: eventObjId }),
        CancellationNotice_1.CancellationNotice.deleteMany({ eventId: eventObjId }),
        InviteeSet_1.InviteeSet.deleteMany({ eventId: eventObjId }),
        Notification_1.Notification.deleteMany({ entityType: 'Event', entityId: eventObjId }),
    ]);
    return { sessionRes, inviteeRes, invitationRes, checkInRes, assignmentRes };
}
exports.eventService = new EventService();
