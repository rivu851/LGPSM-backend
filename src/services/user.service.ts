import mongoose from 'mongoose';
import { userRepository } from '../repositories/user.repository';
import { Role, User } from '../models/User';
import { Event } from '../models/Event';
import { SystemUserAssignment } from '../models/SystemUserAssignment';
import { normalizePhoneNumber } from './whatsapp.service';

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

    const hashedPassword = await hashPassword(data.password);
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
    if (data.password) {
      const { hashPassword } = await import('../utils/password');
      updatePayload.passwordHash = await hashPassword(data.password);
    }
    const user = await userRepository.updateById(userId, updatePayload);
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }
    return user;
  }
};
