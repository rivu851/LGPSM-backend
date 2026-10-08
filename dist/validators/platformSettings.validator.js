"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pricingSchema = exports.notificationPreferencesSchema = exports.eventFeaturesSchema = void 0;
const zod_1 = require("zod");
const flag = zod_1.z.boolean().optional();
exports.eventFeaturesSchema = zod_1.z.object({
    allowEventRSVP: flag,
    acceptInvitedAttendees: flag,
    chooseNotRespondedInvitees: flag,
    chooseRSVPDeclinedInvitees: flag,
    askFoodPreference: flag
}).strict();
exports.notificationPreferencesSchema = zod_1.z.object({
    newOrganizerRegistration: flag,
    newEventAdded: flag,
    deactivatedOrganizerBySuperAdmin: flag,
    changeInPrice: flag,
    invitationSendFailed: flag,
    dayBeforeEventAlert: flag,
    reportDownload: flag,
    customTemplateRequest: flag
}).strict();
exports.pricingSchema = zod_1.z.object({
    ratePerInvitee: zod_1.z.number().finite().min(0, 'Rate cannot be negative').max(1000, 'Rate looks too high')
}).strict();
