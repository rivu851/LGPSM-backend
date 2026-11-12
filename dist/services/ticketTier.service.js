"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ticketTierService = void 0;
const ticketTier_repository_1 = require("../repositories/ticketTier.repository");
const Event_1 = require("../models/Event");
const User_1 = require("../models/User");
exports.ticketTierService = {
    async createTicketTier(eventId, user, data) {
        const isOrganizer = user.role !== User_1.Role.ADMIN && user.role !== 'ADMIN';
        const event = isOrganizer
            ? await Event_1.Event.findOne({ _id: eventId, organizerId: user.userId })
            : await Event_1.Event.findById(eventId);
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        return await ticketTier_repository_1.ticketTierRepository.create({ ...data, eventId: event._id });
    },
    /** Price, capacity and sales of an event belong to its organizer (and the admin): anyone else is told the event does not exist. */
    async getTicketTiers(eventId, user, activeOnly = true) {
        const isOrganizer = user.role !== User_1.Role.ADMIN && user.role !== 'ADMIN';
        const event = isOrganizer
            ? await Event_1.Event.findOne({ _id: eventId, organizerId: user.userId }).select('_id')
            : await Event_1.Event.findById(eventId).select('_id');
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        return await ticketTier_repository_1.ticketTierRepository.findByEventId(eventId, activeOnly);
    },
    async updateTicketTier(id, user, updateData) {
        const tier = await ticketTier_repository_1.ticketTierRepository.findById(id);
        if (!tier)
            throw new Error('TICKET_TIER_NOT_FOUND');
        const isOrganizer = user.role !== User_1.Role.ADMIN && user.role !== 'ADMIN';
        if (isOrganizer) {
            const event = await Event_1.Event.findOne({ _id: tier.eventId, organizerId: user.userId });
            if (!event)
                throw new Error('EVENT_NOT_FOUND');
        }
        const updated = await ticketTier_repository_1.ticketTierRepository.update(id, updateData);
        return updated;
    },
    async deleteTicketTier(id, user) {
        const tier = await ticketTier_repository_1.ticketTierRepository.findById(id);
        if (!tier)
            throw new Error('TICKET_TIER_NOT_FOUND');
        const isOrganizer = user.role !== User_1.Role.ADMIN && user.role !== 'ADMIN';
        if (isOrganizer) {
            const event = await Event_1.Event.findOne({ _id: tier.eventId, organizerId: user.userId });
            if (!event)
                throw new Error('EVENT_NOT_FOUND');
        }
        const deleted = await ticketTier_repository_1.ticketTierRepository.delete(id);
        return deleted;
    }
};
