"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.userService = void 0;
exports.staffVisibleToOrganizer = staffVisibleToOrganizer;
exports.assertPhoneAvailable = assertPhoneAvailable;
const mongoose_1 = __importDefault(require("mongoose"));
const user_repository_1 = require("../repositories/user.repository");
const User_1 = require("../models/User");
const Event_1 = require("../models/Event");
const SystemUserAssignment_1 = require("../models/SystemUserAssignment");
const whatsapp_service_1 = require("./whatsapp.service");
const securityLog_1 = require("../utils/securityLog");
const token_repository_1 = require("../repositories/token.repository");
const email_provider_1 = require("../utils/email.provider");
const crypto_1 = __importDefault(require("crypto"));
const html_1 = require("../utils/html");
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** 12 random characters from an alphabet without look-alike characters (0/O, 1/l/I). */
function generateTemporaryPassword() {
    const bytes = crypto_1.default.randomBytes(12);
    return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}
async function sendCredentialsEmail(email, fullName, role, password) {
    const label = role === User_1.Role.ORGANIZER ? 'organizer' : role === User_1.Role.ADMIN ? 'admin' : 'staff';
    const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:8px">
      <h2 style="color:#111827;margin-top:0">Your LGPSM ${label} account is ready</h2>
      <p style="color:#374151">Hello ${(0, html_1.escapeHtml)(fullName)},</p>
      <p style="color:#374151">Use these details to sign in:</p>
      <table style="margin:16px 0;color:#374151">
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Email</td><td><strong>${(0, html_1.escapeHtml)(email)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Password</td><td><strong style="font-family:monospace;font-size:16px">${password}</strong></td></tr>
      </table>
      <p style="color:#6b7280;font-size:13px">For your security, change this password after your first sign in (Profile &gt; Change Password).</p>
    </div>`;
    await (0, email_provider_1.sendEmail)(email, `Your LGPSM ${label} account`, html);
}
// Staff an organizer works with: accounts they created plus staff assigned to their events
async function staffVisibleToOrganizer(organizerId) {
    const eventIds = await Event_1.Event.find({ organizerId }).distinct('_id');
    const [created, assigned] = await Promise.all([
        User_1.User.find({ role: User_1.Role.SYSTEM_USER, createdBy: organizerId }).distinct('_id'),
        SystemUserAssignment_1.SystemUserAssignment.find({ eventId: { $in: eventIds } }).distinct('userId')
    ]);
    const ids = new Map();
    [...created, ...assigned].forEach((id) => ids.set(String(id), id));
    return [...ids.values()];
}
// Phone numbers sign people in. Two accounts on one number lock both out of phone sign-in (login refuses to guess), so a number
// another account already uses is refused here instead of letting someone lock that person out.
async function assertPhoneAvailable(phone, exceptUserId) {
    if (!phone)
        return;
    const taken = await User_1.User.exists({ phone, ...(exceptUserId ? { _id: { $ne: exceptUserId } } : {}) });
    if (taken)
        throw { statusCode: 409, code: 'PHONE_IN_USE', message: 'This mobile number is already used by another account.' };
}
// An organizer may see the staff who work their events, but may only change an account that is theirs. Staff created by another
// organizer, or also working for one, have their password and email out of reach: changing them would take the account from its owner.
async function assertOrganizerOwnsStaff(organizerId, target) {
    if (target.createdBy && String(target.createdBy) === organizerId)
        return;
    const creator = target.createdBy ? await User_1.User.findById(target.createdBy).select('role').lean() : null;
    const forbidden = { statusCode: 403, message: 'This staff account belongs to another organizer, so only an administrator can change it.' };
    if (creator?.role === User_1.Role.ORGANIZER)
        throw forbidden;
    const eventIds = await SystemUserAssignment_1.SystemUserAssignment.find({ userId: target._id }).distinct('eventId');
    if (await Event_1.Event.exists({ _id: { $in: eventIds }, organizerId: { $ne: organizerId } }))
        throw forbidden;
}
// The platform must always keep someone able to administer it
async function assertNotLastAdmin(target) {
    if (target.role !== User_1.Role.ADMIN || !target.isActive)
        return;
    const others = await User_1.User.countDocuments({ role: User_1.Role.ADMIN, isActive: true, _id: { $ne: target._id } });
    if (others === 0)
        throw { statusCode: 409, code: 'LAST_ADMIN', message: 'This is the only active administrator, so the account cannot be deactivated.' };
}
// Organizers may only manage their own staff accounts (SYSTEM_USER); admins may manage anyone.
async function findManageableUser(actor, userId) {
    const target = await user_repository_1.userRepository.findById(userId);
    if (!target) {
        throw { statusCode: 404, message: 'User not found' };
    }
    if (actor.role === User_1.Role.ORGANIZER) {
        if (target.role !== User_1.Role.SYSTEM_USER) {
            throw { statusCode: 403, message: 'Organizers can only manage staff (SYSTEM_USER) accounts' };
        }
        const visible = await staffVisibleToOrganizer(actor.userId);
        if (!visible.some((id) => String(id) === userId)) {
            throw { statusCode: 404, message: 'User not found' };
        }
    }
    return target;
}
/** A deleted (switched off) staff account added again by the same organizer: brought back with the new details and a new password */
async function reactivateStaff(existing, data, ownerId) {
    const phone = data.phone ? (0, whatsapp_service_1.normalizePhoneNumber)(data.phone) : undefined;
    await assertPhoneAvailable(phone, String(existing._id));
    const { hashPassword } = await Promise.resolve().then(() => __importStar(require('../utils/password')));
    const generatedPassword = data.password ? null : generateTemporaryPassword();
    const passwordHash = await hashPassword(data.password ?? generatedPassword);
    const user = await user_repository_1.userRepository.updateById(String(existing._id), {
        fullName: data.fullName,
        ...(phone ? { phone } : {}),
        passwordHash,
        isActive: true,
        createdBy: new mongoose_1.default.Types.ObjectId(ownerId)
    });
    if (generatedPassword) {
        try {
            await sendCredentialsEmail(data.email, data.fullName, data.role, generatedPassword);
        }
        catch (e) {
            console.error('Credentials email failed:', e?.message);
        }
    }
    return user;
}
exports.userService = {
    async getProfile(userId) {
        const user = await user_repository_1.userRepository.findById(userId);
        if (!user) {
            throw { statusCode: 404, message: 'User not found' };
        }
        return user;
    },
    async updateProfile(userId, data) {
        const { organization, ...personal } = data || {};
        let payload = personal.phone !== undefined ? { ...personal, phone: (0, whatsapp_service_1.normalizePhoneNumber)(personal.phone) } : { ...personal };
        await assertPhoneAvailable(payload.phone, userId);
        if (organization) {
            const me = await user_repository_1.userRepository.findById(userId);
            if (!me)
                throw { statusCode: 404, message: 'User not found' };
            if (me.role !== User_1.Role.ORGANIZER && me.role !== User_1.Role.ADMIN)
                throw { statusCode: 403, message: 'Only organizers can set organization details' };
            // dotted paths: the rest of the profile (logo, avatar) is left exactly as it is
            payload['profile.organizationName'] = organization.name;
            payload['profile.organization'] = {
                phone: organization.phone || undefined, email: organization.email || undefined,
                address: organization.address || undefined, website: organization.website || undefined
            };
            // the name is changed only through `organization`; the other profile fields sent with it are set one by one, because
            // MongoDB refuses a single update that sets both `profile` and `profile.organization`
            const { organizationName: _name, organization: _details, ...otherProfile } = payload.profile || {};
            delete payload.profile;
            for (const [key, value] of Object.entries(otherProfile))
                payload[`profile.${key}`] = value;
        }
        const user = await user_repository_1.userRepository.updateById(userId, payload);
        if (!user) {
            throw { statusCode: 404, message: 'User not found' };
        }
        return user;
    },
    async changePassword(userId, currentPassword, newPassword) {
        const user = await user_repository_1.userRepository.findById(userId);
        if (!user) {
            throw { statusCode: 404, message: 'User not found' };
        }
        if (!user.passwordHash) {
            throw { statusCode: 400, message: 'This account signs in with Google and has no password to change' };
        }
        const { verifyPassword, hashPassword } = await Promise.resolve().then(() => __importStar(require('../utils/password')));
        const matches = await verifyPassword(currentPassword, user.passwordHash);
        if (!matches) {
            throw { statusCode: 400, message: 'Current password is incorrect' };
        }
        user.passwordHash = await hashPassword(newPassword);
        await user.save();
        // Sign out every other session: a stolen refresh token must not outlive the password it was issued under
        await token_repository_1.tokenRepository.revokeAllForUser(userId);
        (0, securityLog_1.securityEvent)('PASSWORD_CHANGED', undefined, { subject: userId });
        return { updated: true };
    },
    async createUser(actor, data) {
        // Role Hierarchy rules
        if (actor.role === 'ORGANIZER' && data.role !== 'SYSTEM_USER') {
            throw { statusCode: 403, message: 'Organizers can only create staff (SYSTEM_USER)' };
        }
        // Admins can create ORGANIZER and SYSTEM_USER (and admins if needed)
        // An admin adding staff for a particular organizer: the account belongs to that organizer, exactly as if they had added it
        let ownerId = actor.userId;
        // a system user always belongs to an organizer: an admin must say which one (an organizer adds staff for themselves)
        if (actor.role === User_1.Role.ADMIN && data.role === User_1.Role.SYSTEM_USER && !data.organizerId) {
            throw { statusCode: 400, code: 'ORGANIZER_REQUIRED', message: 'Select the organizer this user is being added for.' };
        }
        if (data.organizerId) {
            if (actor.role !== 'ADMIN' || data.role !== 'SYSTEM_USER')
                throw { statusCode: 403, message: 'Only an administrator can add staff on behalf of an organizer' };
            const owner = await user_repository_1.userRepository.findById(String(data.organizerId));
            if (!owner || owner.role !== User_1.Role.ORGANIZER || owner.isActive === false)
                throw { statusCode: 404, message: 'Organizer not found' };
            ownerId = String(owner._id);
        }
        // An email belongs to one account on the whole platform. Being someone's invitee is not an account, so a guest's email is free.
        const existingUser = await user_repository_1.userRepository.findByEmail(data.email);
        if (existingUser) {
            const sameOwner = String(existingUser.createdBy || '') === String(ownerId) || actor.role === User_1.Role.ADMIN;
            // Staff that were deleted (deleted accounts are only switched off) come back when they are added again by the same organizer
            if (existingUser.role === User_1.Role.SYSTEM_USER && data.role === User_1.Role.SYSTEM_USER && existingUser.isActive === false && sameOwner) {
                return reactivateStaff(existingUser, data, ownerId);
            }
            const message = existingUser.role === User_1.Role.SYSTEM_USER
                ? existingUser.isActive === false
                    ? 'This email belongs to a deleted system user of another organizer, so it cannot be added here.'
                    : String(existingUser.createdBy || '') === String(ownerId)
                        ? 'This person is already one of your system users.'
                        : 'This email is already used by a system user of another organizer.'
                : existingUser.role === User_1.Role.ORGANIZER
                    ? 'This email is already used by an organizer account.'
                    : 'This email is already used by an administrator account.';
            throw { statusCode: 400, message };
        }
        const phone = data.phone ? (0, whatsapp_service_1.normalizePhoneNumber)(data.phone) : undefined;
        await assertPhoneAvailable(phone);
        const { hashPassword } = await Promise.resolve().then(() => __importStar(require('../utils/password')));
        const { AuthProvider } = await Promise.resolve().then(() => __importStar(require('../models/User')));
        // No password given: generate one and email it with the login email (the person adding the account never sees it)
        const generatedPassword = data.password ? null : generateTemporaryPassword();
        const hashedPassword = await hashPassword(data.password ?? generatedPassword);
        const user = await user_repository_1.userRepository.create({
            fullName: data.fullName,
            email: data.email,
            phone,
            ...(data.profile ? { profile: data.profile } : {}),
            passwordHash: hashedPassword,
            authProvider: AuthProvider.LOCAL,
            role: data.role,
            createdBy: new mongoose_1.default.Types.ObjectId(ownerId)
        });
        if (generatedPassword) {
            try {
                await sendCredentialsEmail(data.email, data.fullName, data.role, generatedPassword);
            }
            catch (err) {
                // The account is useless if nobody can learn its password: undo it so the person can try again
                await user_repository_1.userRepository.deleteByEmail(data.email).catch(() => { });
                throw { statusCode: 502, message: 'The account could not be created because the login email could not be sent. Please try again.' };
            }
        }
        return user;
    },
    async getUsers(actor, role, includeInactive = false, options = {}) {
        const query = includeInactive && actor.role === User_1.Role.ADMIN ? {} : { isActive: true };
        if (role) {
            query.role = role;
        }
        // Organizers only ever see their own staff accounts
        if (actor.role === User_1.Role.ORGANIZER) {
            query.role = User_1.Role.SYSTEM_USER;
            query._id = { $in: await staffVisibleToOrganizer(actor.userId) };
        }
        // An admin looking at one organizer's staff: the same list that organizer sees
        if (actor.role === User_1.Role.ADMIN && options.organizerId && mongoose_1.default.Types.ObjectId.isValid(options.organizerId)) {
            query.role = User_1.Role.SYSTEM_USER;
            query._id = { $in: await staffVisibleToOrganizer(options.organizerId) };
        }
        if (options.search) {
            const normalizedPhone = (0, whatsapp_service_1.normalizePhoneNumber)(options.search);
            // Escape regex metacharacters so a search term like "a.b" or "(x)" can't
            // alter the match or throw — this still isn't an indexed match on
            // fullName/email, just a bounded scan over the already-filtered set.
            const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(escaped, 'i');
            query.$or = [
                { fullName: pattern },
                { email: pattern },
                ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
            ];
        }
        const page = Math.max(options.page || 1, 1);
        const limit = Math.min(Math.max(options.limit || 25, 1), 100);
        const skip = (page - 1) * limit;
        const [users, total] = await Promise.all([
            user_repository_1.userRepository.findPage(query, skip, limit),
            user_repository_1.userRepository.count(query),
        ]);
        return { users, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
    },
    async getUserById(actor, userId) {
        return await findManageableUser(actor, userId);
    },
    async deleteUser(actor, userId) {
        const target = await findManageableUser(actor, userId);
        if (actor.role === User_1.Role.ORGANIZER)
            await assertOrganizerOwnsStaff(actor.userId, target);
        await assertNotLastAdmin(target);
        const user = await user_repository_1.userRepository.updateById(userId, { isActive: false });
        if (!user) {
            throw { statusCode: 404, message: 'User not found' };
        }
        await token_repository_1.tokenRepository.revokeAllForUser(userId);
        if (target.role === User_1.Role.ORGANIZER && actor.role === User_1.Role.ADMIN) {
            const { alertService } = await Promise.resolve().then(() => __importStar(require('./alert.service')));
            await alertService.notifyAdmins('deactivatedOrganizerBySuperAdmin', {
                type: 'SYSTEM',
                title: 'Organizer deactivated',
                message: `${target.fullName} (${target.email}) was deactivated by an administrator.`,
                entityType: 'User',
                entityId: target._id
            });
        }
        return { deleted: true };
    },
    async updateUser(actor, userId, data) {
        const target = await findManageableUser(actor, userId);
        if (actor.role === User_1.Role.ORGANIZER)
            await assertOrganizerOwnsStaff(actor.userId, target);
        const updatePayload = {};
        if (data.fullName !== undefined)
            updatePayload.fullName = data.fullName;
        if (data.email !== undefined) {
            const existing = await user_repository_1.userRepository.findByEmail(String(data.email).toLowerCase().trim());
            if (existing && existing._id.toString() !== userId) {
                throw { statusCode: 409, message: 'Email already in use' };
            }
            updatePayload.email = data.email;
        }
        if (data.phone !== undefined) {
            updatePayload.phone = (0, whatsapp_service_1.normalizePhoneNumber)(data.phone);
            await assertPhoneAvailable(updatePayload.phone, userId);
        }
        if (data.isActive !== undefined && actor.role === User_1.Role.ADMIN) {
            if (data.isActive === false)
                await assertNotLastAdmin(target);
            updatePayload.isActive = data.isActive;
        }
        // Only the organizer details an admin manages; the rest of the profile (avatar, etc.) is left as is
        if (data.profile && actor.role === User_1.Role.ADMIN) {
            if (data.profile.organizationName !== undefined)
                updatePayload['profile.organizationName'] = data.profile.organizationName;
            if (data.profile.invitationChannel !== undefined)
                updatePayload['profile.invitationChannel'] = data.profile.invitationChannel;
            if (data.profile.logoKey !== undefined)
                updatePayload['profile.logoKey'] = data.profile.logoKey;
        }
        if (data.password) {
            const { hashPassword } = await Promise.resolve().then(() => __importStar(require('../utils/password')));
            updatePayload.passwordHash = await hashPassword(data.password);
        }
        const user = await user_repository_1.userRepository.updateById(userId, updatePayload);
        if (updatePayload.passwordHash || updatePayload.isActive === false)
            await token_repository_1.tokenRepository.revokeAllForUser(userId);
        if (!user) {
            throw { statusCode: 404, message: 'User not found' };
        }
        return user;
    }
};
