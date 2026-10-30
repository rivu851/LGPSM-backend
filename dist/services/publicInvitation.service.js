"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicInvitationService = void 0;
const alert_service_1 = require("./alert.service");
const Invitee_1 = require("../models/Invitee");
const Event_1 = require("../models/Event");
const Session_1 = require("../models/Session");
const User_1 = require("../models/User");
const invitation_util_1 = require("../utils/invitation.util");
const sessionAccess_1 = require("../utils/sessionAccess");
const context_1 = require("./cardTemplates/context");
const env_1 = require("../config/env");
const Template_1 = require("../models/Template");
const Category_1 = require("../models/Category");
const designs_1 = require("./cardTemplates/designs");
const admissionWindow_1 = require("../utils/admissionWindow");
const publicTheme_1 = require("./cardTemplates/publicTheme");
function dietaryGroups(preference) {
    if (!preference?.enabled || !Array.isArray(preference.options))
        return [];
    const groups = preference.options.filter((option) => !!option && typeof option === 'object' && !Array.isArray(option));
    if (groups.length) {
        return groups.map((group) => ({
            title: String(group.title || preference.title || 'Dietary Preference').trim(),
            options: Array.isArray(group.options) ? group.options.map(String).map((value) => value.trim()).filter(Boolean) : []
        })).filter((group) => group.options.length > 0);
    }
    const options = preference.options.map(String).map((value) => value.trim()).filter(Boolean);
    return options.length ? [{ title: String(preference.title || 'Dietary Preference').trim(), options }] : [];
}
function validateDietarySelections(preference, selections) {
    const groups = dietaryGroups(preference);
    if (selections.length && !groups.length)
        throw new Error('INVALID_DIETARY_PREFERENCE');
    const accepted = [];
    for (const selection of selections) {
        const title = String(selection.title || '').trim();
        const value = String(selection.value || '').trim();
        const group = groups.find((item) => item.title === title && item.options.includes(value));
        if (!group || accepted.some((item) => item.title === title))
            throw new Error('INVALID_DIETARY_PREFERENCE');
        accepted.push({ title, value });
    }
    return accepted;
}
function dietarySummary(selections, groupCount) {
    if (!selections.length)
        return undefined;
    if (groupCount === 1 && selections.length === 1)
        return selections[0].value;
    return selections.map(({ title, value }) => `${title}: ${value}`).join(' · ');
}
exports.publicInvitationService = {
    async getPublicInvitation(rawToken) {
        if (!rawToken || typeof rawToken !== 'string') {
            throw new Error('INVALID_TOKEN');
        }
        const tokenHash = (0, invitation_util_1.hashToken)(rawToken);
        const invitee = await Invitee_1.Invitee.findOne({ qrTokenHash: tokenHash });
        if (!invitee) {
            throw new Error('INVITATION_NOT_FOUND');
        }
        const event = await Event_1.Event.findById(invitee.eventId).select('title description format location contactNumber schedule admission status cancelledAt cancellationReason rsvp dietaryPreference organizerId templateId categoryId subcategoryId');
        if (!event)
            throw new Error('INVITATION_NOT_FOUND');
        const [sessions, organizer] = await Promise.all([
            Session_1.Session.find({ eventId: event._id })
                .select('name schedule inviteeSource sourceSessionId')
                .sort({ 'schedule.start': 1 })
                .lean(),
            User_1.User.findById(event.organizerId).select('profile.organizationName').lean()
        ]);
        // Same design choice the card renderer makes, so the page matches the card in the guest's email
        const [template, categories] = await Promise.all([
            event.templateId ? Template_1.Template.findById(event.templateId).select('cardDesign designSpec').lean() : null,
            Category_1.Category.find({ _id: { $in: [event.categoryId, event.subcategoryId].filter(Boolean) } }).select('name').lean()
        ]);
        const nameOf = (id) => categories.find((c) => String(c._id) === String(id))?.name;
        const design = (0, designs_1.resolveCardDesign)({
            templateDesign: template?.cardDesign,
            categoryName: nameOf(event.categoryId),
            subcategoryName: nameOf(event.subcategoryId),
            title: event.title
        });
        const theme = (0, publicTheme_1.publicThemeFor)(design, template?.designSpec);
        const attendeeSessions = sessions
            .filter((session) => (0, sessionAccess_1.inviteeAllowedInSession)(invitee, session))
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
                organizerName: (0, context_1.cardHostName)(organizer),
                schedule: event.schedule,
                timeZone: env_1.env.APP_TIMEZONE,
                // When guests can be admitted (defaults to the schedule): lets the page say "check-in opens at ..."
                admission: (() => { const w = (0, admissionWindow_1.effectiveAdmission)(event); return w ? { opensAt: w.opensAt, closesAt: w.closesAt } : null; })(),
                sessions: attendeeSessions,
                status: event.status,
                // Only for a cancelled event: when, and the organizer's own note if they wrote one
                cancellation: event.status === 'CANCELLED' ? { cancelledAt: event.cancelledAt ?? null, reason: event.cancellationReason ?? null } : null,
                // Whether guests can answer at all; when off, the page shows no RSVP control (submitRsvp refuses it anyway)
                rsvp: { enabled: !!event.rsvp?.enabled, closesAt: event.rsvp?.enabled ? event.rsvp.acceptanceLastDate || event.schedule?.end || null : null },
                dietaryPreference: event.dietaryPreference
            },
            theme,
            invitee: {
                name: invitee.name,
                rsvpStatus: invitee.rsvpStatus,
                dietaryPreference: invitee.dietaryPreference,
                dietarySelections: invitee.dietarySelections || []
            }
        };
    },
    async submitRsvp(rawToken, rsvpStatus, dietarySelections, legacyDietaryPreference) {
        if (!rawToken || typeof rawToken !== 'string') {
            throw new Error('INVALID_TOKEN');
        }
        const tokenHash = (0, invitation_util_1.hashToken)(rawToken);
        const invitee = await Invitee_1.Invitee.findOne({ qrTokenHash: tokenHash });
        if (!invitee) {
            throw new Error('INVITATION_NOT_FOUND');
        }
        // RSVP follows the event's own rules
        const event = await Event_1.Event.findById(invitee.eventId).select('title status organizerId rsvp schedule dietaryPreference');
        if (!event || event.status === 'CANCELLED')
            throw new Error('EVENT_CANCELLED');
        if (!event.rsvp?.enabled)
            throw new Error('RSVP_DISABLED');
        const closesAt = event.rsvp.acceptanceLastDate || event.schedule?.end;
        if (closesAt && new Date(closesAt) < new Date())
            throw new Error('RSVP_CLOSED');
        const previous = invitee.rsvpStatus;
        invitee.rsvpStatus = rsvpStatus;
        if (rsvpStatus === Invitee_1.RsvpStatus.DECLINED) {
            invitee.dietaryPreference = undefined;
            invitee.dietarySelections = [];
        }
        else if (dietarySelections !== undefined) {
            const validated = validateDietarySelections(event.dietaryPreference, dietarySelections);
            invitee.dietarySelections = validated;
            invitee.dietaryPreference = dietarySummary(validated, dietaryGroups(event.dietaryPreference).length);
        }
        else if (legacyDietaryPreference !== undefined) {
            const value = legacyDietaryPreference.trim();
            if (!value) {
                invitee.dietaryPreference = undefined;
                invitee.dietarySelections = [];
            }
            else {
                const matchingGroup = dietaryGroups(event.dietaryPreference).find((group) => group.options.includes(value));
                if (!matchingGroup)
                    throw new Error('INVALID_DIETARY_PREFERENCE');
                const validated = [{ title: matchingGroup.title, value }];
                invitee.dietarySelections = validated;
                invitee.dietaryPreference = dietarySummary(validated, dietaryGroups(event.dietaryPreference).length);
            }
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
            dietaryPreference: invitee.dietaryPreference,
            dietarySelections: invitee.dietarySelections || []
        };
    }
};
