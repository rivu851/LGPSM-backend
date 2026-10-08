"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicInvitationService = void 0;
const alert_service_1 = require("./alert.service");
const Invitee_1 = require("../models/Invitee");
const Event_1 = require("../models/Event");
const invitation_util_1 = require("../utils/invitation.util");
exports.publicInvitationService = {
    async getPublicInvitation(rawToken) {
        if (!rawToken || typeof rawToken !== 'string') {
            throw new Error('INVALID_TOKEN');
        }
        const tokenHash = (0, invitation_util_1.hashToken)(rawToken);
        const invitee = await Invitee_1.Invitee.findOne({ qrTokenHash: tokenHash }).populate('eventId', 'title description categoryId format location schedule');
        if (!invitee || !invitee.eventId) {
            throw new Error('INVITATION_NOT_FOUND');
        }
        const event = invitee.eventId;
        return {
            event: {
                title: event.title,
                description: event.description,
                format: event.format,
                location: event.location,
                schedule: event.schedule
            },
            invitee: {
                name: invitee.name,
                rsvpStatus: invitee.rsvpStatus,
                dietaryPreference: invitee.dietaryPreference
            }
        };
    },
    async submitRsvp(rawToken, rsvpStatus, dietaryPreference) {
        if (!rawToken || typeof rawToken !== 'string') {
            throw new Error('INVALID_TOKEN');
        }
        const tokenHash = (0, invitation_util_1.hashToken)(rawToken);
        const invitee = await Invitee_1.Invitee.findOne({ qrTokenHash: tokenHash });
        if (!invitee) {
            throw new Error('INVITATION_NOT_FOUND');
        }
        // RSVP follows the event's own rules
        const event = await Event_1.Event.findById(invitee.eventId).select('title status organizerId rsvp schedule');
        if (!event || event.status === 'CANCELLED')
            throw new Error('EVENT_CANCELLED');
        if (!event.rsvp?.enabled)
            throw new Error('RSVP_DISABLED');
        const closesAt = event.rsvp.acceptanceLastDate || event.schedule?.end;
        if (closesAt && new Date(closesAt) < new Date())
            throw new Error('RSVP_CLOSED');
        const previous = invitee.rsvpStatus;
        invitee.rsvpStatus = rsvpStatus;
        if (dietaryPreference !== undefined) {
            invitee.dietaryPreference = dietaryPreference;
        }
        await invitee.save();
        if (previous !== rsvpStatus && rsvpStatus !== Invitee_1.RsvpStatus.PENDING) {
            await alert_service_1.alertService.notifyUser(event.organizerId, {
                type: 'RSVP',
                title: 'RSVP received',
                message: `${invitee.name} ${rsvpStatus === Invitee_1.RsvpStatus.ACCEPTED ? 'accepted' : 'declined'} your invitation to "${event.title}".`,
                entityType: 'Event',
                entityId: event._id
            });
        }
        return {
            message: 'RSVP submitted successfully',
            name: invitee.name,
            rsvpStatus: invitee.rsvpStatus,
            dietaryPreference: invitee.dietaryPreference
        };
    }
};
