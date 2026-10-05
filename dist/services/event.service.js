"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventService = exports.EventService = void 0;
const event_repository_1 = require("../repositories/event.repository");
const Event_1 = require("../models/Event");
const Category_1 = require("../models/Category");
const Template_1 = require("../models/Template");
const Session_1 = require("../models/Session");
const Invitee_1 = require("../models/Invitee");
const Invitation_1 = require("../models/Invitation");
const CheckIn_1 = require("../models/CheckIn");
const SystemUserAssignment_1 = require("../models/SystemUserAssignment");
const User_1 = require("../models/User");
const mongoose_1 = __importDefault(require("mongoose"));
class EventService {
    async createEvent(organizerId, eventData) {
        // Resolve Category
        let categoryId = eventData.categoryId;
        let categoryExists = categoryId && mongoose_1.default.Types.ObjectId.isValid(categoryId)
            ? await Category_1.Category.findById(categoryId)
            : null;
        if (categoryId && !categoryExists) {
            const err = new Error('CATEGORY_NOT_FOUND');
            err.statusCode = 400;
            throw err;
        }
        if (!categoryExists) {
            let defaultCat = await Category_1.Category.findOne({ name: 'General' });
            if (!defaultCat) {
                defaultCat = await Category_1.Category.create({ name: 'General', isActive: true });
            }
            categoryId = defaultCat?._id;
        }
        // Validate Template if provided
        if (eventData.templateId && mongoose_1.default.Types.ObjectId.isValid(eventData.templateId)) {
            const templateExists = await Template_1.Template.findById(eventData.templateId);
            if (!templateExists) {
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
            organizerId: new mongoose_1.default.Types.ObjectId(organizerId),
            status: 'PUBLISHED'
        };
        return await event_repository_1.eventRepository.create(dataToCreate);
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
            : await event_repository_1.eventRepository.findByIdAndOrganizer(eventId, organizerId);
        if (!event) {
            throw new Error('EVENT_NOT_FOUND');
        }
        return event;
    }
    // Read model for detail screens: resolves the related category, subcategory and template for display
    async getEventDetails(eventId, organizerId, role) {
        const event = await this.getEventById(eventId, organizerId, role);
        await event.populate([
            { path: 'categoryId', select: 'name subcategories' },
            { path: 'templateId', select: 'name previewImageKey isActive' },
        ]);
        const json = event.toJSON();
        // subcategoryId references an embedded subcategory of the category; expose its name alongside the id
        const category = json.categoryId;
        if (json.subcategoryId && category && Array.isArray(category.subcategories)) {
            const sub = category.subcategories.find((s) => String(s._id) === String(json.subcategoryId));
            if (sub)
                json.subcategory = { _id: sub._id, name: sub.name };
        }
        if (category && typeof category === 'object')
            delete category.subcategories;
        return json;
    }
    async updateEvent(eventId, organizerId, updateData) {
        // Check if event exists
        const existingEvent = await this.getEventById(eventId, organizerId);
        // Validate references if they are being updated
        if (updateData.categoryId && updateData.categoryId !== existingEvent.categoryId.toString()) {
            const categoryExists = await Category_1.Category.findById(updateData.categoryId);
            if (!categoryExists)
                throw new Error('CATEGORY_NOT_FOUND');
        }
        if (updateData.templateId && updateData.templateId !== existingEvent.templateId?.toString()) {
            const templateExists = await Template_1.Template.findById(updateData.templateId);
            if (!templateExists)
                throw new Error('TEMPLATE_NOT_FOUND');
        }
        // Disallow updating organizerId, _id, createdAt
        delete updateData.organizerId;
        delete updateData._id;
        delete updateData.createdAt;
        const updatedEvent = await event_repository_1.eventRepository.updateByIdAndOrganizer(eventId, organizerId, updateData);
        if (!updatedEvent) {
            throw new Error('UPDATE_FAILED');
        }
        return updatedEvent;
    }
    async deactivateEvent(eventId, organizerId) {
        // Ensure it exists first
        await this.getEventById(eventId, organizerId);
        const deletedEvent = await event_repository_1.eventRepository.softDeleteByIdAndOrganizer(eventId, organizerId);
        if (!deletedEvent) {
            throw new Error('DELETION_FAILED');
        }
        return deletedEvent;
    }
    async cleanupEventOperationalData(eventId, actor) {
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
        // 4. Validate Event Has Ended
        const now = new Date();
        const endDate = event.schedule?.end ? new Date(event.schedule.end) : null;
        const isEnded = (endDate && now > endDate) || event.status === Event_1.EventStatus.COMPLETED;
        if (!isEnded) {
            throw new Error('EVENT_NOT_ENDED');
        }
        // 5. Atomic Deletion of Event-Specific Operational Data
        // DO NOT DELETE GLOBAL USERS (User model)!
        const eventObjId = new mongoose_1.default.Types.ObjectId(eventId);
        const [sessionRes, inviteeRes, invitationRes, checkInRes, assignmentRes] = await Promise.all([
            Session_1.Session.deleteMany({ eventId: eventObjId }),
            Invitee_1.Invitee.deleteMany({ eventId: eventObjId }),
            Invitation_1.Invitation.deleteMany({ eventId: eventObjId }),
            CheckIn_1.CheckIn.deleteMany({ eventId: eventObjId }),
            SystemUserAssignment_1.SystemUserAssignment.deleteMany({ eventId: eventObjId }),
        ]);
        event.operationalDataCleared = true;
        event.status = Event_1.EventStatus.COMPLETED;
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
exports.eventService = new EventService();
