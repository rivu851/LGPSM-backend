import { z } from 'zod';

const flag = z.boolean().optional();

export const eventFeaturesSchema = z.object({
  allowEventRSVP: flag,
  acceptInvitedAttendees: flag,
  chooseNotRespondedInvitees: flag,
  chooseRSVPDeclinedInvitees: flag,
  askFoodPreference: flag
}).strict();

export const notificationPreferencesSchema = z.object({
  newOrganizerRegistration: flag,
  newEventAdded: flag,
  deactivatedOrganizerBySuperAdmin: flag,
  changeInPrice: flag,
  invitationSendFailed: flag,
  dayBeforeEventAlert: flag,
  reportDownload: flag,
  customTemplateRequest: flag
}).strict();

export const pricingSchema = z.object({
  ratePerInvitee: z.number().finite().min(0, 'Rate cannot be negative').max(1000, 'Rate looks too high')
}).strict();
