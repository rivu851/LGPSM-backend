import mongoose from 'mongoose';
import { escapeHtml } from '../utils/html';
import { Notification } from '../models/Notification';
import { User, Role } from '../models/User';
import { INotificationPreferences } from '../models/PlatformSettings';
import { platformSettingsService } from './platformSettings.service';
import { sendEmail } from '../utils/email.provider';

export interface AlertContent {
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: unknown;
  count?: number;
}


function toDoc(userId: unknown, content: AlertContent) {
  return {
    userId,
    type: content.type,
    title: content.title,
    message: content.message,
    entityType: content.entityType,
    entityId: content.entityId && mongoose.Types.ObjectId.isValid(String(content.entityId)) ? content.entityId : undefined,
    isRead: false,
    ...(content.count !== undefined ? { count: content.count } : {})
  };
}

// Alerts are side effects: they never make the action that triggered them fail
async function safely(label: string, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (err) {
    console.error(`Alert "${label}" could not be delivered:`, (err as Error).message);
  }
}

export const alertService = {
  // Platform alerts for administrators, governed by the admin notification preferences
  async notifyAdmins(preference: keyof INotificationPreferences, content: AlertContent, opts: { email?: boolean } = {}) {
    await safely(content.title, async () => {
      const prefs = await platformSettingsService.getNotificationPreferences();
      if (!prefs[preference]) return;
      const admins = await User.find({ role: Role.ADMIN, isActive: true }).select('_id email fullName').lean();
      if (admins.length === 0) return;
      await Notification.insertMany(admins.map((a) => toDoc(a._id, content)));
      // Email goes out in the background so a slow mail server never delays the request
      if (opts.email === false) return; // in-app only (high-volume or purely informative notices)
      void Promise.all(
        admins
          .filter((a) => a.email)
          .map((a) =>
            sendEmail(a.email, `LGPSM: ${content.title}`, `<p>${escapeHtml(content.message)}</p><p style="color:#828282;font-size:12px">You can change these alerts in Settings &gt; Notifications Settings.</p>`)
              .catch((err: Error) => console.error('Admin alert email failed:', err.message))
          )
      );
    });
  },

  // In-app notification for one user (e.g. the organizer of an event)
  async notifyUser(userId: unknown, content: AlertContent) {
    await safely(content.title, () => Notification.create(toDoc(userId, content)));
  },

  // Everyone who organizes events (an announcement such as a new template or category)
  async notifyAllOrganizers(content: AlertContent) {
    await safely(content.title, async () => {
      const organizers = await User.find({ role: Role.ORGANIZER, isActive: true }).select('_id').lean();
      if (organizers.length === 0) return;
      await Notification.insertMany(organizers.map((o) => toDoc(o._id, content)));
    });
  },

  /**
   * A running count instead of one notification per event of the same kind: while an unread notice of this kind for the same
   * subject is still recent, it is updated ("12 guests checked in … in the last 27 minutes") rather than another one added.
   * Returns nothing; like every alert it never fails the action that caused it.
   */
  async rollup(userIds: unknown[], opts: { type: string; entityType: string; entityId: unknown; windowMinutes: number; title: string; describe: (count: number, minutes: number) => string }) {
    await safely(opts.title, async () => {
      const since = new Date(Date.now() - opts.windowMinutes * 60_000);
      for (const userId of userIds) {
        const existing = await Notification.findOne({ userId, type: opts.type, entityId: opts.entityId as any, createdAt: { $gte: since } }).sort({ createdAt: -1 });
        if (existing) {
          const count = (existing.count ?? 1) + 1;
          const minutes = Math.max(1, Math.round((Date.now() - existing.createdAt.getTime()) / 60_000));
          existing.count = count;
          existing.message = opts.describe(count, minutes);
          existing.isRead = false;
          await existing.save();
        } else {
          await Notification.create(toDoc(userId, { type: opts.type, title: opts.title, message: opts.describe(1, 1), entityType: opts.entityType, entityId: opts.entityId, count: 1 }));
        }
      }
    });
  },

  // Check-ins at the door: the event's organizer and the administrators see a running count while guests arrive
  async guestCheckedIn(event: { _id: unknown; title: string; organizerId?: unknown }, staffName: string) {
    await safely('guest check-in', async () => {
      const prefs = await platformSettingsService.getNotificationPreferences();
      const admins = prefs.guestCheckIns ? (await User.find({ role: Role.ADMIN, isActive: true }).select('_id').lean()).map((a) => a._id) : [];
      const recipients = [...(event.organizerId ? [event.organizerId] : []), ...admins];
      const minutesText = (m: number) => (m <= 1 ? 'the last minute' : `the last ${m} minutes`);
      await this.rollup(recipients, {
        type: 'GUEST_CHECK_IN',
        entityType: 'Event',
        entityId: event._id,
        windowMinutes: 30,
        title: 'Guests are checking in',
        describe: (count, minutes) => `${count} ${count === 1 ? 'guest has' : 'guests have'} checked in to "${event.title}" in ${minutesText(minutes)} (latest scanned by ${staffName}).`
      });
    });
  }
};
