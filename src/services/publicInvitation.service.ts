import { alertService } from './alert.service';
import { Invitee, RsvpStatus } from '../models/Invitee';
import { Event } from '../models/Event';
import { Session } from '../models/Session';
import { User } from '../models/User';
import { CredentialEvent } from '../models/CredentialEvent';
import { credentialStatus } from '../utils/credentialPolicy';
import { hashToken } from '../utils/invitation.util';
import { inviteeAllowedInSession } from '../utils/sessionAccess';
import { cardHostName } from './cardTemplates/context';
import { env } from '../config/env';
import { Template } from '../models/Template';
import { Category } from '../models/Category';
import { resolveCardDesign } from './cardTemplates/designs';
import { effectiveAdmission } from '../utils/admissionWindow';
import { publicThemeFor } from './cardTemplates/publicTheme';

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
      // A link whose pass was replaced: explain it (and name the event) without revealing the new pass
      const old: any = await CredentialEvent.findOne({ tokenHash }).select('+tokenHash eventId inviteeId createdAt').lean();
      const successor = old && (await CredentialEvent.exists({ inviteeId: old.inviteeId, createdAt: { $gt: old.createdAt }, type: 'REPLACED' }));
      if (old && successor) {
        const ev: any = await Event.findById(old.eventId).select('title').lean();
        const who: any = await Invitee.findById(old.inviteeId).select('name').lean();
        if (ev && who) return { credential: { status: 'REPLACED' as const }, event: { title: ev.title }, invitee: { name: who.name } };
      }
      throw new Error('INVITATION_NOT_FOUND');
    }

    const event = await Event.findById(invitee.eventId).select('title description format location contactNumber schedule admission status cancelledAt cancellationReason rsvp dietaryPreference organizerId templateId categoryId subcategoryId');
    if (!event) throw new Error('INVITATION_NOT_FOUND');

    const [sessions, organizer] = await Promise.all([
      Session.find({ eventId: event._id })
        .select('name schedule inviteeSource sourceSessionId')
        .sort({ 'schedule.start': 1 })
        .lean(),
      User.findById(event.organizerId).select('profile.organizationName').lean()
    ]);
    // Same design choice the card renderer makes, so the page matches the card in the guest's email
    const [template, categories] = await Promise.all([
      event.templateId ? Template.findById(event.templateId).select('cardDesign designSpec').lean() : null,
      Category.find({ _id: { $in: [event.categoryId, event.subcategoryId].filter(Boolean) } }).select('name').lean()
    ]);
    const nameOf = (id: unknown) => categories.find((c: any) => String(c._id) === String(id))?.name;
    const design = resolveCardDesign({
      templateDesign: (template as any)?.cardDesign,
      categoryName: nameOf(event.categoryId),
      subcategoryName: nameOf(event.subcategoryId),
      title: event.title
    });
    const theme = publicThemeFor(design, (template as any)?.designSpec);
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
        // When guests can be admitted (defaults to the schedule): lets the page say "check-in opens at ..."
        admission: (() => { const w = effectiveAdmission(event as any); return w ? { opensAt: w.opensAt, closesAt: w.closesAt } : null; })(),
        sessions: attendeeSessions,
        status: event.status,
        // Only for a cancelled event: when, and the organizer's own note if they wrote one
        cancellation: event.status === 'CANCELLED' ? { cancelledAt: (event as any).cancelledAt ?? null, reason: (event as any).cancellationReason ?? null } : null,
        // Whether guests can answer at all; when off, the page shows no RSVP control (submitRsvp refuses it anyway)
        rsvp: { enabled: !!event.rsvp?.enabled, closesAt: event.rsvp?.enabled ? event.rsvp.acceptanceLastDate || event.schedule?.end || null : null },
        dietaryPreference: event.dietaryPreference
      },
      theme,
      // The guest's CURRENT pass: the page hides the pass image when it is revoked (never says "replaced" for a pass that has a successor)
      credential: { status: credentialStatus(invitee as any, event as any).status },
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

    // A guest who declines has no food preference to give: refuse it instead of quietly dropping it (also for direct API calls)
    if (rsvpStatus === RsvpStatus.DECLINED && ((dietarySelections && dietarySelections.length > 0) || (legacyDietaryPreference && legacyDietaryPreference.trim()))) {
      throw new Error('DIETARY_NOT_ALLOWED_WHEN_DECLINED');
    }

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
