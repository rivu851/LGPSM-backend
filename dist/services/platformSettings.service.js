"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.platformSettingsService = void 0;
const currency_1 = require("../constants/currency");
const cache_1 = require("../infra/cache");
const mongoose_1 = __importDefault(require("mongoose"));
const User_1 = require("../models/User");
const PlatformSettings_1 = require("../models/PlatformSettings");
const PriceRateChange_1 = require("../models/PriceRateChange");
const KEY = 'global';
async function load() {
    // Upsert so the defaults exist without a separate seeding step
    return PlatformSettings_1.PlatformSettings.findOneAndUpdate({ key: KEY }, { $setOnInsert: { key: KEY } }, { new: true, upsert: true, setDefaultsOnInsert: true });
}
// The platform settings are read on almost every bill, notification and event, and change only when an administrator saves them (any write
// clears this cache: see models/PlatformSettings.ts). Readers use the cached copy (a plain object); anything that decides a write reads fresh.
async function loadCached() {
    return (0, cache_1.cached)('settings', 'global', 60, async () => JSON.parse(JSON.stringify(await load())));
}
const featureKeys = ['allowEventRSVP', 'acceptInvitedAttendees', 'chooseNotRespondedInvitees', 'chooseRSVPDeclinedInvitees', 'askFoodPreference'];
const notificationKeys = [
    'newOrganizerRegistration', 'newEventAdded', 'deactivatedOrganizerBySuperAdmin', 'changeInPrice',
    'invitationSendFailed', 'dayBeforeEventAlert', 'reportDownload', 'customTemplateRequest', 'newContactMessage',
    'guestCheckIns', 'invitationsSent', 'eventCancelled'
];
const pick = (src, keys) => Object.fromEntries(keys.map((k) => [k, !!src?.[k]]));
exports.platformSettingsService = {
    async getEventFeatures() {
        return pick((await loadCached()).eventFeatures, featureKeys);
    },
    async updateEventFeatures(features) {
        const set = Object.fromEntries(Object.entries(features).filter(([k]) => featureKeys.includes(k)).map(([k, v]) => [`eventFeatures.${k}`, !!v]));
        const doc = await PlatformSettings_1.PlatformSettings.findOneAndUpdate({ key: KEY }, { $set: set }, { new: true, upsert: true, setDefaultsOnInsert: true });
        return pick(doc.eventFeatures, featureKeys);
    },
    async getNotificationPreferences() {
        return pick((await loadCached()).notificationPreferences, notificationKeys);
    },
    async updateNotificationPreferences(prefs) {
        const set = Object.fromEntries(Object.entries(prefs).filter(([k]) => notificationKeys.includes(k)).map(([k, v]) => [`notificationPreferences.${k}`, !!v]));
        const doc = await PlatformSettings_1.PlatformSettings.findOneAndUpdate({ key: KEY }, { $set: set }, { new: true, upsert: true, setDefaultsOnInsert: true });
        return pick(doc.notificationPreferences, notificationKeys);
    },
    async getPricing() {
        const settings = await loadCached();
        const history = await PriceRateChange_1.PriceRateChange.find().sort({ createdAt: -1 }).limit(100).populate('changedBy', 'fullName email').lean();
        return {
            ratePerInvitee: settings.pricing?.ratePerInvitee ?? null,
            gstPercent: settings.pricing?.gstPercent ?? 18,
            currency: currency_1.PLATFORM_CURRENCY,
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
        const currency = currency_1.PLATFORM_CURRENCY;
        await PlatformSettings_1.PlatformSettings.updateOne({ key: KEY }, { $set: { 'pricing.ratePerInvitee': ratePerInvitee, 'pricing.updatedAt': new Date(), 'pricing.updatedBy': new mongoose_1.default.Types.ObjectId(actorId) } });
        await PriceRateChange_1.PriceRateChange.create({ previousRate: previous, newRate: ratePerInvitee, currency, changedBy: actorId });
        return this.getPricing();
    },
    /** GST (%) added to every bill; the current value applies to bills made from now on */
    async gstPercent() {
        const settings = await loadCached();
        const g = Number(settings.pricing?.gstPercent);
        return Number.isFinite(g) && g >= 0 ? g : 18;
    },
    async updateGst(actorId, gstPercent) {
        await PlatformSettings_1.PlatformSettings.updateOne({ key: KEY }, { $set: { 'pricing.gstPercent': gstPercent, 'pricing.updatedAt': new Date(), 'pricing.updatedBy': new mongoose_1.default.Types.ObjectId(actorId) } });
        return this.getPricing();
    },
    // Rate snapshot stored on a newly created event
    async currentRateSnapshot(organizerId) {
        const settings = await loadCached();
        const custom = organizerId ? await this.customRateOf(organizerId) : null;
        return { ratePerInvitee: custom ?? settings.pricing?.ratePerInvitee ?? null, currency: currency_1.PLATFORM_CURRENCY, lockedAt: new Date() };
    },
    /** The rate an administrator set for one organizer, or null when the platform rate applies to them */
    async customRateOf(organizerId) {
        if (!organizerId || !mongoose_1.default.Types.ObjectId.isValid(String(organizerId)))
            return null;
        const u = await User_1.User.findById(String(organizerId)).select('customRatePerInvitee').lean();
        const r = u?.customRatePerInvitee;
        return typeof r === 'number' && Number.isFinite(r) && r >= 0 ? r : null;
    },
    /** What an organizer is charged per invitee: their own rate when an administrator set one, otherwise the platform rate (null = none set) */
    async rateForOrganizer(organizerId) {
        const settings = await loadCached();
        const custom = await this.customRateOf(organizerId);
        return { customRate: custom, defaultRate: settings.pricing?.ratePerInvitee ?? null, effectiveRate: custom ?? settings.pricing?.ratePerInvitee ?? null, currency: currency_1.PLATFORM_CURRENCY };
    },
    async setOrganizerRate(actorId, organizerId, rate) {
        await User_1.User.updateOne({ _id: organizerId, role: 'ORGANIZER' }, { $set: { customRatePerInvitee: rate } });
        return this.rateForOrganizer(organizerId);
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
