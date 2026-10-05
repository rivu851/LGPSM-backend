import { alertService } from './alert.service';
import { Invitee, RsvpStatus } from '../models/Invitee';
import { Event } from '../models/Event';
import { hashToken } from '../utils/invitation.util';

export const publicInvitationService = {
  async getPublicInvitation(rawToken: string) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('INVALID_TOKEN');
    }

    const tokenHash = hashToken(rawToken);
    const invitee = await Invitee.findOne({ qrTokenHash: tokenHash }).populate('eventId', 'title description categoryId format location schedule');

    if (!invitee || !invitee.eventId) {
      throw new Error('INVITATION_NOT_FOUND');
    }

    const event = invitee.eventId as any;

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

  async submitRsvp(rawToken: string, rsvpStatus: RsvpStatus, dietaryPreference?: string) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('INVALID_TOKEN');
    }

    const tokenHash = hashToken(rawToken);
    const invitee = await Invitee.findOne({ qrTokenHash: tokenHash });

    if (!invitee) {
      throw new Error('INVITATION_NOT_FOUND');
    }

    // RSVP follows the event's own rules
    const event = await Event.findById(invitee.eventId).select('title status organizerId rsvp schedule');
    if (!event || event.status === 'CANCELLED') throw new Error('EVENT_CANCELLED');
    if (!event.rsvp?.enabled) throw new Error('RSVP_DISABLED');
    const closesAt = event.rsvp.acceptanceLastDate || event.schedule?.end;
    if (closesAt && new Date(closesAt) < new Date()) throw new Error('RSVP_CLOSED');

    const previous = invitee.rsvpStatus;
    invitee.rsvpStatus = rsvpStatus;
    if (dietaryPreference !== undefined) {
      invitee.dietaryPreference = dietaryPreference;
    }

    await invitee.save();

    if (previous !== rsvpStatus && rsvpStatus !== RsvpStatus.PENDING) {
      await alertService.notifyUser(event.organizerId, {
        type: 'RSVP',
        title: 'RSVP received',
        message: `${invitee.name} ${rsvpStatus === RsvpStatus.ACCEPTED ? 'accepted' : 'declined'} your invitation to "${event.title}".`,
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
