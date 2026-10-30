"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicInvitationController = void 0;
const publicInvitation_service_1 = require("../services/publicInvitation.service");
const invitation_service_1 = require("../services/invitation.service");
exports.publicInvitationController = {
    async getPublicInvitationCard(req, res) {
        try {
            const token = req.params.token;
            const png = await invitation_service_1.invitationService.publicInvitationCard(token);
            res.setHeader('Content-Type', 'image/png');
            // The invitation page is served from another origin (the web app) and shows this card in an <img>; helmet's default
            // same-origin policy would make the browser refuse to display it. The token in the URL is the access control.
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('Content-Disposition', 'inline; filename="digital-access-pass.png"');
            return res.status(200).send(png);
        }
        catch (error) {
            if (error.message === 'INVITATION_NOT_FOUND' || error.message === 'INVALID_TOKEN') {
                return res.status(404).json({ success: false, message: 'Invitation not found or token is invalid' });
            }
            if (error.message === 'CREDENTIAL_REPLACED') {
                return res.status(410).json({ success: false, code: 'CREDENTIAL_REPLACED', message: 'This access pass was replaced. Please use the new one we sent you.' });
            }
            if (error.message === 'CREDENTIAL_REVOKED') {
                return res.status(410).json({ success: false, code: 'CREDENTIAL_REVOKED', message: 'This access pass has been withdrawn and no longer works.' });
            }
            if (error.message === 'EVENT_CANCELLED') {
                return res.status(410).json({ success: false, code: 'EVENT_CANCELLED', message: 'This event has been cancelled. This access pass is no longer valid.' });
            }
            console.error('Request failed:', error?.message);
            return res.status(500).json({ success: false, message: 'Could not render the digital pass.' });
        }
    },
    async getPublicInvitation(req, res) {
        try {
            const token = req.params.token;
            const data = await publicInvitation_service_1.publicInvitationService.getPublicInvitation(token);
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            if (error.message === 'INVITATION_NOT_FOUND' || error.message === 'INVALID_TOKEN') {
                return res.status(404).json({ success: false, error: 'Not Found', message: 'Invitation not found or token is invalid' });
            }
            console.error('Request failed:', error?.message);
            return res.status(500).json({ success: false, error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    },
    async submitRsvp(req, res) {
        try {
            const token = req.params.token;
            const { rsvpStatus, dietarySelections, dietaryPreference } = req.body;
            const data = await publicInvitation_service_1.publicInvitationService.submitRsvp(token, rsvpStatus, dietarySelections, dietaryPreference);
            return res.status(200).json({ success: true, data });
        }
        catch (error) {
            if (error.message === 'INVITATION_NOT_FOUND' || error.message === 'INVALID_TOKEN') {
                return res.status(404).json({ success: false, error: 'Not Found', message: 'Invitation not found or token is invalid' });
            }
            if (error.message === 'EVENT_CANCELLED') {
                return res.status(410).json({ success: false, code: 'EVENT_CANCELLED', message: 'This event has been cancelled. Your response was not saved.' });
            }
            if (error.message === 'RSVP_DISABLED') {
                return res.status(400).json({ success: false, message: 'RSVP is not open for this event.' });
            }
            if (error.message === 'RSVP_CLOSED') {
                return res.status(400).json({ success: false, message: 'The RSVP deadline for this event has passed.' });
            }
            if (error.message === 'DIETARY_NOT_ALLOWED_WHEN_DECLINED') {
                return res.status(400).json({ success: false, code: 'DIETARY_NOT_ALLOWED_WHEN_DECLINED', message: 'A food preference can only be given when you accept.' });
            }
            if (error.message === 'INVALID_DIETARY_PREFERENCE') {
                return res.status(400).json({ success: false, message: 'Choose only from the dietary options provided for this event.' });
            }
            console.error('Request failed:', error?.message);
            return res.status(500).json({ success: false, error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
        }
    }
};
