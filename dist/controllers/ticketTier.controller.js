"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ticketTierController = void 0;
const ticketTier_service_1 = require("../services/ticketTier.service");
exports.ticketTierController = {
    async createTicketTier(req, res) {
        try {
            const eventId = req.params.eventId;
            const user = { userId: req.user.userId, role: req.user.role };
            const tier = await ticketTier_service_1.ticketTierService.createTicketTier(eventId, user, req.body);
            return res.status(201).json({ success: true, data: tier });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
            return res.status(400).json({ error: 'Bad Request', message: error.message });
        }
    },
    async getTicketTiers(req, res) {
        try {
            const eventId = req.params.eventId;
            const activeOnly = req.query.activeOnly !== 'false';
            const tiers = await ticketTier_service_1.ticketTierService.getTicketTiers(eventId, activeOnly);
            return res.status(200).json({ success: true, data: tiers });
        }
        catch (error) {
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    },
    async updateTicketTier(req, res) {
        try {
            const user = { userId: req.user.userId, role: req.user.role };
            const tier = await ticketTier_service_1.ticketTierService.updateTicketTier(req.params.id, user, req.body);
            return res.status(200).json({ success: true, data: tier });
        }
        catch (error) {
            if (error.message === 'TICKET_TIER_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Ticket tier not found' });
            if (error.message === 'EVENT_NOT_FOUND')
                return res.status(403).json({ error: 'Forbidden', message: 'Access denied' });
            return res.status(400).json({ error: 'Bad Request', message: error.message });
        }
    },
    async deleteTicketTier(req, res) {
        try {
            const user = { userId: req.user.userId, role: req.user.role };
            const tier = await ticketTier_service_1.ticketTierService.deleteTicketTier(req.params.id, user);
            return res.status(200).json({ success: true, message: 'Ticket tier deactivated', data: tier });
        }
        catch (error) {
            if (error.message === 'TICKET_TIER_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Ticket tier not found' });
            if (error.message === 'EVENT_NOT_FOUND')
                return res.status(403).json({ error: 'Forbidden', message: 'Access denied' });
            console.error('Request failed:', error?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    }
};
