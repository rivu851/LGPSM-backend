"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invitationController = void 0;
const invitation_service_1 = require("../services/invitation.service");
const Invitation_1 = require("../models/Invitation");
exports.invitationController = {
    async sendInvitations(req, res) {
        try {
            const eventId = req.params.eventId;
            const { inviteeIds, channel, channels } = req.body;
            const user = {
                userId: req.user?.userId,
                role: req.user?.role
            };
            let selectedChannel = channel;
            if (!selectedChannel && Array.isArray(channels)) {
                const hasEmail = channels.includes('EMAIL');
                const hasWhatsApp = channels.includes('WHATSAPP');
                if (hasEmail && hasWhatsApp) {
                    selectedChannel = Invitation_1.DeliveryChannel.BOTH;
                }
                else if (hasWhatsApp) {
                    selectedChannel = Invitation_1.DeliveryChannel.WHATSAPP;
                }
                else if (hasEmail) {
                    selectedChannel = Invitation_1.DeliveryChannel.EMAIL;
                }
            }
            const results = await invitation_service_1.invitationService.sendInvitations(eventId, user, inviteeIds, selectedChannel || Invitation_1.DeliveryChannel.EMAIL);
            return res.status(200).json({ success: true, message: 'Invitations processed successfully', results });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
            if (error.message === 'INVALID_INVITEES')
                return res.status(400).json({ error: 'Bad Request', message: 'One or more invitees do not belong to this event' });
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    },
    async resendInvitations(req, res) {
        try {
            const eventId = req.params.eventId;
            const { invitationIds, channel } = req.body;
            const user = {
                userId: req.user?.userId,
                role: req.user?.role
            };
            const results = await invitation_service_1.invitationService.resendInvitations(eventId, user, invitationIds, channel);
            return res.status(200).json({ success: true, message: 'Invitations resent successfully', results });
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
            if (error.message === 'INVALID_INVITATIONS')
                return res.status(400).json({ error: 'Bad Request', message: 'One or more invitations do not belong to this event' });
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    },
    async getInvitations(req, res) {
        try {
            const eventId = req.params.eventId;
            const user = {
                userId: req.user?.userId,
                role: req.user?.role
            };
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const data = await invitation_service_1.invitationService.getInvitations(eventId, user, page, limit);
            return res.status(200).json(data);
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    },
    async previewInvitationCard(req, res) {
        try {
            const eventId = req.params.eventId;
            const inviteeId = req.query.inviteeId;
            const user = {
                userId: req.user?.userId,
                role: req.user?.role
            };
            const { png: pngBuffer, qr } = await invitation_service_1.invitationService.previewInvitationCard(eventId, user, inviteeId);
            res.setHeader('Content-Type', 'image/png');
            // ISSUED: the QR is the guest's current check-in pass; SAMPLE: placeholder, not valid for check-in
            res.setHeader('X-Invitation-Qr', qr);
            res.setHeader('Content-Disposition', 'inline; filename="invitation-card-preview.png"');
            return res.status(200).send(pngBuffer);
        }
        catch (error) {
            if (error.message === 'EVENT_NOT_FOUND')
                return res.status(404).json({ error: 'Not Found', message: 'Event not found' });
            return res.status(500).json({ error: 'Internal Server Error', message: error.message });
        }
    }
};
