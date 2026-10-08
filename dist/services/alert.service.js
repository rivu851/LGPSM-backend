"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.alertService = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const Notification_1 = require("../models/Notification");
const User_1 = require("../models/User");
const platformSettings_service_1 = require("./platformSettings.service");
const email_provider_1 = require("../utils/email.provider");
const escapeHtml = (v) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function toDoc(userId, content) {
    return {
        userId,
        type: content.type,
        title: content.title,
        message: content.message,
        entityType: content.entityType,
        entityId: content.entityId && mongoose_1.default.Types.ObjectId.isValid(String(content.entityId)) ? content.entityId : undefined,
        isRead: false
    };
}
// Alerts are side effects: they never make the action that triggered them fail
async function safely(label, work) {
    try {
        await work();
    }
    catch (err) {
        console.error(`Alert "${label}" could not be delivered:`, err.message);
    }
}
exports.alertService = {
    // Platform alerts for administrators, governed by the admin notification preferences
    async notifyAdmins(preference, content) {
        await safely(content.title, async () => {
            const prefs = await platformSettings_service_1.platformSettingsService.getNotificationPreferences();
            if (!prefs[preference])
                return;
            const admins = await User_1.User.find({ role: User_1.Role.ADMIN, isActive: true }).select('_id email fullName').lean();
            if (admins.length === 0)
                return;
            await Notification_1.Notification.insertMany(admins.map((a) => toDoc(a._id, content)));
            // Email goes out in the background so a slow mail server never delays the request
            void Promise.all(admins
                .filter((a) => a.email)
                .map((a) => (0, email_provider_1.sendEmail)(a.email, `LGPSM: ${content.title}`, `<p>${escapeHtml(content.message)}</p><p style="color:#828282;font-size:12px">You can change these alerts in Settings &gt; Notifications Settings.</p>`)
                .catch((err) => console.error('Admin alert email failed:', err.message))));
        });
    },
    // In-app notification for one user (e.g. the organizer of an event)
    async notifyUser(userId, content) {
        await safely(content.title, () => Notification_1.Notification.create(toDoc(userId, content)));
    }
};
