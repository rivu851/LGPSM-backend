import { alertService } from './alert.service';
import { Invitee, RsvpStatus } from '../models/Invitee';
import { Event } from '../models/Event';
import { Session } from '../models/Session';
import { User } from '../models/User';
import { hashToken } from '../utils/invitation.util';
import { inviteeAllowedInSession } from '../utils/sessionAccess';
import { cardHostName } from './cardTemplates/context';
import { env } from '../config/env';

interface DietarySelection {
  title: string;
  value: string;
}

function dietaryGroups(preference: any): { title: string; options: string[] }[] {
  if (!preference?.enabled || !Array.isArray(preference.options)) return [];
  const groups = preference.options.filter((option: unknown) => !!option && typeof option === 'object' && !Array.isArray(option));
  if (groups.length) {
    return groups.map((group: any) => ({
      title: String(group.title || preference.title || 'Dietary Preference').trim(),
      options: Array.isArray(group.options) ? group.options.map(String).map((value: string) => value.trim()).filter(Boolean) : []
    })).filter((group: { options: string[] }) => group.options.length > 0);
  }
  const options = preference.options.map(String).map((value: string) => value.trim()).filter(Boolean);
  return options.length ? [{ title: String(preference.title || 'Dietary Preference').trim(), options }] : [];
}

function validateDietarySelections(preference: any, selections: DietarySelection[]): DietarySelection[] {
  const groups = dietaryGroups(preference);
  if (selections.length && !groups.length) throw new Error('INVALID_DIETARY_PREFERENCE');
  const accepted: DietarySelection[] = [];
  for (const selection of selections) {
    const title = String(selection.title || '').trim();
    const value = String(selection.value || '').trim();
    const group = groups.find((item) => item.title === title && item.options.includes(value));
    if (!group || accepted.some((item) => item.title === title)) throw new Error('INVALID_DIETARY_PREFERENCE');
    accepted.push({ title, value });
  }
  return accepted;
}

function dietarySummary(selections: DietarySelection[], groupCount: number): string | undefined {
  if (!selections.length) return undefined;
  if (groupCount === 1 && selections.length === 1) return selections[0].value;
  return selections.map(({ title, value }) => `${title}: ${value}`).join(' · ');
}

export const publicInvitationService = {
  async getPublicInvitation(rawToken: string) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('INVALID_TOKEN');
    }

    const tokenHash = hashToken(rawToken);
    const invitee = await Invitee.findOne({ qrTokenHash: tokenHash });

    if (!invitee) {
      throw new Error('INVITATION_NOT_FOUND');
    }

    const event = await Event.findById(invitee.eventId).select('title description format location contactNumber schedule status rsvp dietaryPreference organizerId');
    if (!event) throw new Error('INVITATION_NOT_FOUND');

    const [sessions, organizer] = await Promise.all([
      Session.find({ eventId: event._id })
        .select('name schedule inviteeSource sourceSessionId')
        .sort({ 'schedule.start': 1 })
        .lean(),
      User.findById(event.organizerId).select('profile.organizationName').lean()
    ]);
    const attendeeSessions = sessions
      .filter((session) => inviteeAllowedInSession(invitee, session as any))
      .map((session) => ({
        name: session.name,
        start: session.schedule?.start,
        end: session.schedule?.end
      }));

    return {
      event: {
        title: event.title,
        description: event.description,
        format: event.format,
        location: event.location,
        contactNumber: event.contactNumber,
        organizerName: cardHostName(organizer as any),
        schedule: event.schedule,
        timeZone: env.APP_TIMEZONE,
        sessions: attendeeSessions,
        status: event.status,
        // Whether guests can answer at all; when off, the page shows no RSVP control (submitRsvp refuses it anyway)
        rsvp: { enabled: !!event.rsvp?.enabled, closesAt: event.rsvp?.enabled ? event.rsvp.acceptanceLastDate || event.schedule?.end || null : null },
        dietaryPreference: event.dietaryPreference
      },
      invitee: {
        name: invitee.name,
        rsvpStatus: invitee.rsvpStatus,
        dietaryPreference: invitee.dietaryPreference,
        dietarySelections: invitee.dietarySelections || []
      }
    };
  },

  async submitRsvp(rawToken: string, rsvpStatus: RsvpStatus, dietarySelections?: DietarySelection[], legacyDietaryPreference?: string) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('INVALID_TOKEN');
    }

    const tokenHash = hashToken(rawToken);
    const invitee = await Invitee.findOne({ qrTokenHash: tokenHash });

    if (!invitee) {
      throw new Error('INVITATION_NOT_FOUND');
    }

    // RSVP follows the event's own rules
    const event = await Event.findById(invitee.eventId).select('title status organizerId rsvp schedule dietaryPreference');
    if (!event || event.status === 'CANCELLED') throw new Error('EVENT_CANCELLED');
    if (!event.rsvp?.enabled) throw new Error('RSVP_DISABLED');
    const closesAt = event.rsvp.acceptanceLastDate || event.schedule?.end;
    if (closesAt && new Date(closesAt) < new Date()) throw new Error('RSVP_CLOSED');

    const previous = invitee.rsvpStatus;
    invitee.rsvpStatus = rsvpStatus;
    if (rsvpStatus === RsvpStatus.DECLINED) {
      invitee.dietaryPreference = undefined;
      invitee.dietarySelections = [];
    } else if (dietarySelections !== undefined) {
      const validated = validateDietarySelections(event.dietaryPreference, dietarySelections);
      invitee.dietarySelections = validated;
      invitee.dietaryPreference = dietarySummary(validated, dietaryGroups(event.dietaryPreference).length);
    } else if (legacyDietaryPreference !== undefined) {
      const value = legacyDietaryPreference.trim();
      if (!value) {
        invitee.dietaryPreference = undefined;
        invitee.dietarySelections = [];
      } else {
        const matchingGroup = dietaryGroups(event.dietaryPreference).find((group) => group.options.includes(value));
        if (!matchingGroup) throw new Error('INVALID_DIETARY_PREFERENCE');
        const validated = [{ title: matchingGroup.title, value }];
        invitee.dietarySelections = validated;
        invitee.dietaryPreference = dietarySummary(validated, dietaryGroups(event.dietaryPreference).length);
      }
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
      dietaryPreference: invitee.dietaryPreference,
      dietarySelections: invitee.dietarySelections || []
    };
  }
};
