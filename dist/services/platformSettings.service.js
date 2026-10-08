"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.platformSettingsService = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const PlatformSettings_1 = require("../models/PlatformSettings");
const PriceRateChange_1 = require("../models/PriceRateChange");
const KEY = 'global';
async function load() {
    // Upsert so the defaults exist without a separate seeding step
    return PlatformSettings_1.PlatformSettings.findOneAndUpdate({ key: KEY }, { $setOnInsert: { key: KEY } }, { new: true, upsert: true, setDefaultsOnInsert: true });
}
const featureKeys = ['allowEventRSVP', 'acceptInvitedAttendees', 'chooseNotRespondedInvitees', 'chooseRSVPDeclinedInvitees', 'askFoodPreference'];
const notificationKeys = [
    'newOrganizerRegistration', 'newEventAdded', 'deactivatedOrganizerBySuperAdmin', 'changeInPrice',
    'invitationSendFailed', 'dayBeforeEventAlert', 'reportDownload', 'customTemplateRequest'
];
const pick = (src, keys) => Object.fromEntries(keys.map((k) => [k, !!src?.[k]]));
exports.platformSettingsService = {
    async getEventFeatures() {
        return pick((await load()).eventFeatures, featureKeys);
    },
    async updateEventFeatures(features) {
        const set = Object.fromEntries(Object.entries(features).filter(([k]) => featureKeys.includes(k)).map(([k, v]) => [`eventFeatures.${k}`, !!v]));
        const doc = await PlatformSettings_1.PlatformSettings.findOneAndUpdate({ key: KEY }, { $set: set }, { new: true, upsert: true, setDefaultsOnInsert: true });
        return pick(doc.eventFeatures, featureKeys);
    },
    async getNotificationPreferences() {
        return pick((await load()).notificationPreferences, notificationKeys);
    },
    async updateNotificationPreferences(prefs) {
        const set = Object.fromEntries(Object.entries(prefs).filter(([k]) => notificationKeys.includes(k)).map(([k, v]) => [`notificationPreferences.${k}`, !!v]));
        const doc = await PlatformSettings_1.PlatformSettings.findOneAndUpdate({ key: KEY }, { $set: set }, { new: true, upsert: true, setDefaultsOnInsert: true });
        return pick(doc.notificationPreferences, notificationKeys);
    },
    async getPricing() {
        const settings = await load();
        const history = await PriceRateChange_1.PriceRateChange.find().sort({ createdAt: -1 }).limit(100).populate('changedBy', 'fullName email').lean();
        return {
            ratePerInvitee: settings.pricing?.ratePerInvitee ?? null,
            currency: settings.pricing?.currency || 'USD',
            updatedAt: settings.pricing?.updatedAt || null,
            history
        };
    },
    // The new rate applies to events created from now on; existing events keep their locked rate
    async updateRate(actorId, ratePerInvitee) {
        const settings = await load();
        const previous = settings.pricing?.ratePerInvitee ?? null;
        if (previous !== null && Math.abs(previous - ratePerInvitee) < 0.00001) {
            return this.getPricing();
        }
        const currency = settings.pricing?.currency || 'USD';
        await PlatformSettings_1.PlatformSettings.updateOne({ key: KEY }, { $set: { 'pricing.ratePerInvitee': ratePerInvitee, 'pricing.updatedAt': new Date(), 'pricing.updatedBy': new mongoose_1.default.Types.ObjectId(actorId) } });
        await PriceRateChange_1.PriceRateChange.create({ previousRate: previous, newRate: ratePerInvitee, currency, changedBy: actorId });
        return this.getPricing();
    },
    // Rate snapshot stored on a newly created event
    async currentRateSnapshot() {
        const settings = await load();
        return { ratePerInvitee: settings.pricing?.ratePerInvitee ?? null, currency: settings.pricing?.currency || 'USD', lockedAt: new Date() };
    },
    // For events created before rates were locked on events: the rate that was in effect at that time
    async rateInEffectAt(when) {
        const change = await PriceRateChange_1.PriceRateChange.findOne({ createdAt: { $lte: when } }).sort({ createdAt: -1 }).lean();
        return change ? change.newRate : null;
    },
    // Disabled options are forced off on events so the backend, not only the UI, honours the admin settings
    // On create the full rsvp block is written so schema defaults cannot re-enable a disabled option.
    async applyEventFeatureRules(eventData, isCreate = false) {
        const f = await this.getEventFeatures();
        if (isCreate && !eventData.rsvp)
            eventData.rsvp = {};
        if (eventData.rsvp) {
            if (!f.allowEventRSVP) {
                eventData.rsvp.enabled = false;
                delete eventData.rsvp.acceptanceLastDate;
            }
            if (!f.acceptInvitedAttendees)
                eventData.rsvp.allowAllInvited = false;
            if (!f.chooseNotRespondedInvitees)
                eventData.rsvp.allowNotResponded = false;
            if (!f.chooseRSVPDeclinedInvitees)
                eventData.rsvp.allowDeclined = false;
        }
        if (!f.askFoodPreference && eventData.dietaryPreference) {
            eventData.dietaryPreference.enabled = false;
        }
        return eventData;
    }
};
