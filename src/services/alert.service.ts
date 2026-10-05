import mongoose from 'mongoose';
import { Notification } from '../models/Notification';
import { User, Role } from '../models/User';
import { INotificationPreferences } from '../models/PlatformSettings';
import { platformSettingsService } from './platformSettings.service';
import { sendEmail } from '../utils/email.provider';

interface AlertContent {
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: unknown;
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function toDoc(userId: unknown, content: AlertContent) {
  return {
    userId,
    type: content.type,
    title: content.title,
    message: content.message,
    entityType: content.entityType,
    entityId: content.entityId && mongoose.Types.ObjectId.isValid(String(content.entityId)) ? content.entityId : undefined,
    isRead: false
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
  async notifyAdmins(preference: keyof INotificationPreferences, content: AlertContent) {
    await safely(content.title, async () => {
      const prefs = await platformSettingsService.getNotificationPreferences();
      if (!prefs[preference]) return;
      const admins = await User.find({ role: Role.ADMIN, isActive: true }).select('_id email fullName').lean();
      if (admins.length === 0) return;
      await Notification.insertMany(admins.map((a) => toDoc(a._id, content)));
      // Email goes out in the background so a slow mail server never delays the request
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
  }
};
