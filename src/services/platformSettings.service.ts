import mongoose from 'mongoose';
import { PlatformSettings, IEventFeatures, INotificationPreferences } from '../models/PlatformSettings';
import { PriceRateChange } from '../models/PriceRateChange';

const KEY = 'global';

async function load() {
  // Upsert so the defaults exist without a separate seeding step
  return PlatformSettings.findOneAndUpdate({ key: KEY }, { $setOnInsert: { key: KEY } }, { new: true, upsert: true, setDefaultsOnInsert: true });
}

const featureKeys: (keyof IEventFeatures)[] = ['allowEventRSVP', 'acceptInvitedAttendees', 'chooseNotRespondedInvitees', 'chooseRSVPDeclinedInvitees', 'askFoodPreference'];
const notificationKeys: (keyof INotificationPreferences)[] = [
  'newOrganizerRegistration', 'newEventAdded', 'deactivatedOrganizerBySuperAdmin', 'changeInPrice',
  'invitationSendFailed', 'dayBeforeEventAlert', 'reportDownload', 'customTemplateRequest'
];
const pick = <K extends string>(src: any, keys: K[]) => Object.fromEntries(keys.map((k) => [k, !!src?.[k]])) as Record<K, boolean>;

export const platformSettingsService = {
  async getEventFeatures(): Promise<IEventFeatures> {
    return pick((await load()).eventFeatures, featureKeys);
  },

  async updateEventFeatures(features: Partial<IEventFeatures>): Promise<IEventFeatures> {
    const set = Object.fromEntries(Object.entries(features).filter(([k]) => featureKeys.includes(k as any)).map(([k, v]) => [`eventFeatures.${k}`, !!v]));
    const doc = await PlatformSettings.findOneAndUpdate({ key: KEY }, { $set: set }, { new: true, upsert: true, setDefaultsOnInsert: true });
    return pick(doc!.eventFeatures, featureKeys);
  },

  async getNotificationPreferences(): Promise<INotificationPreferences> {
    return pick((await load()).notificationPreferences, notificationKeys);
  },

  async updateNotificationPreferences(prefs: Partial<INotificationPreferences>): Promise<INotificationPreferences> {
    const set = Object.fromEntries(Object.entries(prefs).filter(([k]) => notificationKeys.includes(k as any)).map(([k, v]) => [`notificationPreferences.${k}`, !!v]));
    const doc = await PlatformSettings.findOneAndUpdate({ key: KEY }, { $set: set }, { new: true, upsert: true, setDefaultsOnInsert: true });
    return pick(doc!.notificationPreferences, notificationKeys);
  },

  async getPricing() {
    const settings = await load();
    const history = await PriceRateChange.find().sort({ createdAt: -1 }).limit(100).populate('changedBy', 'fullName email').lean();
    return {
      ratePerInvitee: settings.pricing?.ratePerInvitee ?? null,
      currency: settings.pricing?.currency || 'USD',
      updatedAt: settings.pricing?.updatedAt || null,
      history
    };
  },

  // The new rate applies to events created from now on; existing events keep their locked rate
  async updateRate(actorId: string, ratePerInvitee: number) {
    const settings = await load();
    const previous = settings.pricing?.ratePerInvitee ?? null;
    if (previous !== null && Math.abs(previous - ratePerInvitee) < 0.00001) {
      return this.getPricing();
    }
    const currency = settings.pricing?.currency || 'USD';
    await PlatformSettings.updateOne(
      { key: KEY },
      { $set: { 'pricing.ratePerInvitee': ratePerInvitee, 'pricing.updatedAt': new Date(), 'pricing.updatedBy': new mongoose.Types.ObjectId(actorId) } }
    );
    await PriceRateChange.create({ previousRate: previous, newRate: ratePerInvitee, currency, changedBy: actorId });
    return this.getPricing();
  },

  // Rate snapshot stored on a newly created event
  async currentRateSnapshot() {
    const settings = await load();
    return { ratePerInvitee: settings.pricing?.ratePerInvitee ?? null, currency: settings.pricing?.currency || 'USD', lockedAt: new Date() };
  },

  // For events created before rates were locked on events: the rate that was in effect at that time
  async rateInEffectAt(when: Date): Promise<number | null> {
    const change = await PriceRateChange.findOne({ createdAt: { $lte: when } }).sort({ createdAt: -1 }).lean();
    return change ? change.newRate : null;
  },

  // Disabled options are forced off on events so the backend, not only the UI, honours the admin settings
  // On create the full rsvp block is written so schema defaults cannot re-enable a disabled option.
  async applyEventFeatureRules(eventData: any, isCreate = false) {
    const f = await this.getEventFeatures();
    if (isCreate && !eventData.rsvp) eventData.rsvp = {};
    if (eventData.rsvp) {
      if (!f.allowEventRSVP) {
        eventData.rsvp.enabled = false;
        delete eventData.rsvp.acceptanceLastDate;
      }
      if (!f.acceptInvitedAttendees) eventData.rsvp.allowAllInvited = false;
      if (!f.chooseNotRespondedInvitees) eventData.rsvp.allowNotResponded = false;
      if (!f.chooseRSVPDeclinedInvitees) eventData.rsvp.allowDeclined = false;
    }
    if (!f.askFoodPreference && eventData.dietaryPreference) {
      eventData.dietaryPreference.enabled = false;
    }
    return eventData;
  }
};
