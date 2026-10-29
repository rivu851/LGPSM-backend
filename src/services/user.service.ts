import mongoose from 'mongoose';
import { userRepository } from '../repositories/user.repository';
import { Role, User } from '../models/User';
import { Event } from '../models/Event';
import { SystemUserAssignment } from '../models/SystemUserAssignment';
import { normalizePhoneNumber } from './whatsapp.service';
import { securityEvent } from '../utils/securityLog';
import { tokenRepository } from '../repositories/token.repository';
import { sendEmail } from '../utils/email.provider';
import crypto from 'crypto';

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 12 random characters from an alphabet without look-alike characters (0/O, 1/l/I). */
function generateTemporaryPassword(): string {
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

async function sendCredentialsEmail(email: string, fullName: string, role: string, password: string): Promise<void> {
  const label = role === Role.ORGANIZER ? 'organizer' : role === Role.ADMIN ? 'admin' : 'staff';
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:8px">
      <h2 style="color:#111827;margin-top:0">Your LGPSM ${label} account is ready</h2>
      <p style="color:#374151">Hello ${fullName},</p>
      <p style="color:#374151">Use these details to sign in:</p>
      <table style="margin:16px 0;color:#374151">
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Email</td><td><strong>${email}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Password</td><td><strong style="font-family:monospace;font-size:16px">${password}</strong></td></tr>
      </table>
      <p style="color:#6b7280;font-size:13px">For your security, change this password after your first sign in (Profile &gt; Change Password).</p>
    </div>`;
  await sendEmail(email, `Your LGPSM ${label} account`, html);
}

export interface Actor {
  userId: string;
  role: string;
}

// Staff an organizer works with: accounts they created plus staff assigned to their events
export async function staffVisibleToOrganizer(organizerId: string): Promise<mongoose.Types.ObjectId[]> {
  const eventIds = await Event.find({ organizerId }).distinct('_id');
  const [created, assigned] = await Promise.all([
    User.find({ role: Role.SYSTEM_USER, createdBy: organizerId }).distinct('_id'),
    SystemUserAssignment.find({ eventId: { $in: eventIds } }).distinct('userId')
  ]);
  const ids = new Map<string, mongoose.Types.ObjectId>();
  [...created, ...assigned].forEach((id: any) => ids.set(String(id), id));
  return [...ids.values()];
}

// Organizers may only manage their own staff accounts (SYSTEM_USER); admins may manage anyone.
async function findManageableUser(actor: Actor, userId: string) {
  const target = await userRepository.findById(userId);
  if (!target) {
    throw { statusCode: 404, message: 'User not found' };
  }
  if (actor.role === Role.ORGANIZER) {
    if (target.role !== Role.SYSTEM_USER) {
      throw { statusCode: 403, message: 'Organizers can only manage staff (SYSTEM_USER) accounts' };
    }
    const visible = await staffVisibleToOrganizer(actor.userId);
    if (!visible.some((id) => String(id) === userId)) {
      throw { statusCode: 404, message: 'User not found' };
    }
  }
  return target;
}

export const userService = {
  async getProfile(userId: string) {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }
    return user;
  },

  async updateProfile(userId: string, data: any) {
    const payload = data.phone !== undefined ? { ...data, phone: normalizePhoneNumber(data.phone) } : data;
    const user = await userRepository.updateById(userId, payload);
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }
    return user;
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }
    if (!user.passwordHash) {
      throw { statusCode: 400, message: 'This account signs in with Google and has no password to change' };
    }

    const { verifyPassword, hashPassword } = await import('../utils/password');
    const matches = await verifyPassword(currentPassword, user.passwordHash);
    if (!matches) {
      throw { statusCode: 400, message: 'Current password is incorrect' };
    }

    user.passwordHash = await hashPassword(newPassword);
    await user.save();
    // Sign out every other session: a stolen refresh token must not outlive the password it was issued under
    await tokenRepository.revokeAllForUser(userId);
    securityEvent('PASSWORD_CHANGED', undefined, { subject: userId });
    return { updated: true };
  },

  async createUser(actor: Actor, data: any) {
    // Role Hierarchy rules
    if (actor.role === 'ORGANIZER' && data.role !== 'SYSTEM_USER') {
      throw { statusCode: 403, message: 'Organizers can only create staff (SYSTEM_USER)' };
    }
    // Admins can create ORGANIZER and SYSTEM_USER (and admins if needed)

    const existingUser = await userRepository.findByEmail(data.email);
    if (existingUser) {
      throw { statusCode: 400, message: 'Email already in use' };
    }

    const { hashPassword } = await import('../utils/password');
    const { AuthProvider } = await import('../models/User');

    // No password given: generate one and email it with the login email (the person adding the account never sees it)
    const generatedPassword = data.password ? null : generateTemporaryPassword();
    const hashedPassword = await hashPassword(data.password ?? generatedPassword!);
    const user = await userRepository.create({
      fullName: data.fullName,
      email: data.email,
      phone: data.phone ? normalizePhoneNumber(data.phone) : undefined,
      ...(data.profile ? { profile: data.profile } : {}),
      passwordHash: hashedPassword,
      authProvider: AuthProvider.LOCAL,
      role: data.role,
      createdBy: new mongoose.Types.ObjectId(actor.userId)
    });

    if (generatedPassword) {
      try {
        await sendCredentialsEmail(data.email, data.fullName, data.role, generatedPassword);
      } catch (err) {
        // The account is useless if nobody can learn its password: undo it so the person can try again
        await userRepository.deleteByEmail(data.email).catch(() => {});
        throw { statusCode: 502, message: 'The account could not be created because the login email could not be sent. Please try again.' };
      }
    }

    return user;
  },

  async getUsers(
    actor: Actor,
    role?: string,
    includeInactive = false,
    options: { page?: number; limit?: number; search?: string } = {}
  ) {
    const query: any = includeInactive && actor.role === Role.ADMIN ? {} : { isActive: true };
    if (role) {
      query.role = role;
    }
    // Organizers only ever see their own staff accounts
    if (actor.role === Role.ORGANIZER) {
      query.role = Role.SYSTEM_USER;
      query._id = { $in: await staffVisibleToOrganizer(actor.userId) };
    }

    if (options.search) {
      const normalizedPhone = normalizePhoneNumber(options.search);
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
      userRepository.findPage(query, skip, limit),
      userRepository.count(query),
    ]);

    return { users, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  },

  async getUserById(actor: Actor, userId: string) {
    return await findManageableUser(actor, userId);
  },

  async deleteUser(actor: Actor, userId: string) {
    const target = await findManageableUser(actor, userId);
    const user = await userRepository.updateById(userId, { isActive: false });
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }
    await tokenRepository.revokeAllForUser(userId);
    if (target.role === Role.ORGANIZER && actor.role === Role.ADMIN) {
      const { alertService } = await import('./alert.service');
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

  async updateUser(actor: Actor, userId: string, data: any) {
    await findManageableUser(actor, userId);

    const updatePayload: any = {};
    if (data.fullName !== undefined) updatePayload.fullName = data.fullName;
    if (data.email !== undefined) {
      const existing = await userRepository.findByEmail(String(data.email).toLowerCase().trim());
      if (existing && (existing as any)._id.toString() !== userId) {
        throw { statusCode: 409, message: 'Email already in use' };
      }
      updatePayload.email = data.email;
    }
    if (data.phone !== undefined) updatePayload.phone = normalizePhoneNumber(data.phone);
    if (data.isActive !== undefined && actor.role === Role.ADMIN) updatePayload.isActive = data.isActive;
    // Only the organizer details an admin manages; the rest of the profile (avatar, etc.) is left as is
    if (data.profile && actor.role === Role.ADMIN) {
      if (data.profile.organizationName !== undefined) updatePayload['profile.organizationName'] = data.profile.organizationName;
      if (data.profile.logoKey !== undefined) updatePayload['profile.logoKey'] = data.profile.logoKey;
    }
    if (data.password) {
      const { hashPassword } = await import('../utils/password');
      updatePayload.passwordHash = await hashPassword(data.password);
    }
    const user = await userRepository.updateById(userId, updatePayload);
    if (updatePayload.passwordHash || updatePayload.isActive === false) await tokenRepository.revokeAllForUser(userId);
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }
    return user;
  }
};
