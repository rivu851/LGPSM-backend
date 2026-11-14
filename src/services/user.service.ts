import { auditLogService } from './auditLog.service';
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
import { escapeHtml } from '../utils/html';

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
      <p style="color:#374151">Hello ${escapeHtml(fullName)},</p>
      <p style="color:#374151">Use these details to sign in:</p>
      <table style="margin:16px 0;color:#374151">
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Email</td><td><strong>${escapeHtml(email)}</strong></td></tr>
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

// An organizer may see the staff who work their events, but may only change an account that is theirs. Staff created by another
// organizer, or also working for one, have their password and email out of reach: changing them would take the account from its owner.
async function assertOrganizerOwnsStaff(organizerId: string, target: any) {
  if (target.createdBy && String(target.createdBy) === organizerId) return;
  const creator: any = target.createdBy ? await User.findById(target.createdBy).select('role').lean() : null;
  const forbidden = { statusCode: 403, message: 'This staff account belongs to another organizer, so only an administrator can change it.' };
  if (creator?.role === Role.ORGANIZER) throw forbidden;
  const eventIds = await SystemUserAssignment.find({ userId: target._id }).distinct('eventId');
  if (await Event.exists({ _id: { $in: eventIds }, organizerId: { $ne: organizerId } })) throw forbidden;
}

// The platform must always keep someone able to administer it
async function assertNotLastAdmin(target: any) {
  if (target.role !== Role.ADMIN || !target.isActive) return;
  const others = await User.countDocuments({ role: Role.ADMIN, isActive: true, _id: { $ne: target._id } });
  if (others === 0) throw { statusCode: 409, code: 'LAST_ADMIN', message: 'This is the only active administrator, so the account cannot be deactivated.' };
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

/** A deleted (switched off) staff account added again by the same organizer: brought back with the new details and a new password */

/**
 * Every switch of an account on or off is written to the audit log as its own entry (who, which account, from what to what, and by which
 * route), on top of the generic entry the route itself leaves. Best effort: a failed audit write is logged and never undoes the change.
 */
async function auditStateChange(actor: Actor, target: any, active: boolean, via: 'DELETE' | 'PATCH' | 'RE_ADD') {
  const owner = target.role === Role.SYSTEM_USER ? target.createdBy : target.role === Role.ORGANIZER ? target._id : undefined;
  await auditLogService.record({
    actorId: actor.userId,
    actorRole: actor.role,
    organizerId: owner,
    action: active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
    entityType: 'User',
    entityId: target._id,
    description: `${target.role === Role.SYSTEM_USER ? 'Staff member' : 'Account'} ${active ? 'activated' : 'deactivated'}`,
    metadata: { targetRole: target.role, from: !active, to: active, via }
  });
}

async function reactivateStaff(existing: any, data: any, ownerId: string) {
  const phone = data.phone ? normalizePhoneNumber(data.phone) : undefined;
  const { hashPassword } = await import('../utils/password');
  const generatedPassword = data.password ? null : generateTemporaryPassword();
  const passwordHash = await hashPassword(data.password ?? generatedPassword!);
  const user = await userRepository.updateById(String(existing._id), {
    fullName: data.fullName,
    ...(phone ? { phone } : {}),
    passwordHash,
    isActive: true,
    createdBy: new mongoose.Types.ObjectId(ownerId)
  } as any);
  if (generatedPassword) {
    try { await sendCredentialsEmail(data.email, data.fullName, data.role, generatedPassword); } catch (e: any) { console.error('Credentials email failed:', e?.message); }
  }
  return user;
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
    const { organization, ...personal } = data || {};
    let payload: any = personal.phone !== undefined ? { ...personal, phone: normalizePhoneNumber(personal.phone) } : { ...personal };
    if (organization) {
      const me = await userRepository.findById(userId);
      if (!me) throw { statusCode: 404, message: 'User not found' };
      if (me.role !== Role.ORGANIZER && me.role !== Role.ADMIN) throw { statusCode: 403, message: 'Only organizers can set organization details' };
      // dotted paths: the rest of the profile (logo, avatar) is left exactly as it is
      payload['profile.organizationName'] = organization.name;
      payload['profile.organization'] = {
        phone: organization.phone || undefined, whatsapp: organization.whatsapp || undefined, email: organization.email || undefined,
        address: organization.address || undefined, website: organization.website || undefined
      };
      // the name is changed only through `organization`; the other profile fields sent with it are set one by one, because
      // MongoDB refuses a single update that sets both `profile` and `profile.organization`
      const { organizationName: _name, organization: _details, ...otherProfile } = payload.profile || {};
      delete payload.profile;
      for (const [key, value] of Object.entries(otherProfile)) payload[`profile.${key}`] = value;
    }
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

    // An admin adding staff for a particular organizer: the account belongs to that organizer, exactly as if they had added it
    let ownerId = actor.userId;
    // a system user always belongs to an organizer: an admin must say which one (an organizer adds staff for themselves)
    if (actor.role === Role.ADMIN && data.role === Role.SYSTEM_USER && !data.organizerId) {
      throw { statusCode: 400, code: 'ORGANIZER_REQUIRED', message: 'Select the organizer this user is being added for.' };
    }
    if (data.organizerId) {
      if (actor.role !== 'ADMIN' || data.role !== 'SYSTEM_USER') throw { statusCode: 403, message: 'Only an administrator can add staff on behalf of an organizer' };
      const owner = await userRepository.findById(String(data.organizerId));
      if (!owner || owner.role !== Role.ORGANIZER || owner.isActive === false) throw { statusCode: 404, message: 'Organizer not found' };
      ownerId = String(owner._id);
    }

    // An administrator's email is never shared: an admin cannot be created on an email another account uses, and nobody else can take an
    // admin's. (Organizers and system users may share an email with each other.)
    const lowered = String(data.email).toLowerCase().trim();
    if (data.role === Role.ADMIN) {
      if (await User.exists({ email: lowered })) throw { statusCode: 400, message: 'This email address is already used by another account, so it cannot be an administrator account.' };
    } else if (await User.exists({ email: lowered, role: Role.ADMIN })) {
      throw { statusCode: 400, message: 'This email address belongs to an administrator account, so it cannot be used for another account.' };
    }

    // One organizer account per email. (System users may share an email with an organizer and with each other.)
    if (data.role === Role.ORGANIZER && (await User.exists({ email: String(data.email).toLowerCase().trim(), role: Role.ORGANIZER }))) {
      throw { statusCode: 400, message: 'An organizer account already uses this email address.' };
    }

    // Reuse a deleted staff account owned by this organizer when possible. Other
    // accounts may share an email or phone number.
    if (data.role === Role.SYSTEM_USER) {
      const mine: any[] = await User.find({ email: String(data.email).toLowerCase().trim(), role: Role.SYSTEM_USER, createdBy: ownerId });
      // other accounts, and other organizers' staff, may share this email; the same organizer's own list shows a person once
      if (mine.some((u) => u.isActive !== false)) throw { statusCode: 400, message: 'This person is already one of your system users.' };
      const inactiveStaff = mine.find((u) => u.isActive === false);
      if (inactiveStaff) {
        // Bringing a deactivated account back is an administrator's decision. An organizer adding the same person again would do exactly
        // that (by reusing the old account, or by making a new one to get round the deactivation), so it is refused.
        if (actor.role !== Role.ADMIN) {
          throw { statusCode: 403, code: 'STAFF_DEACTIVATED_ADMIN_ONLY', message: 'This person was deactivated earlier. Only an administrator can bring them back; please ask one to reactivate them.' };
        }
        const back = await reactivateStaff(inactiveStaff, data, ownerId);
        await auditStateChange(actor, inactiveStaff, true, 'RE_ADD');
        return back;
      }
    }

    const phone = data.phone ? normalizePhoneNumber(data.phone) : undefined;

    const { hashPassword } = await import('../utils/password');
    const { AuthProvider } = await import('../models/User');

    // No password given: generate one and email it with the login email (the person adding the account never sees it)
    const generatedPassword = data.password ? null : generateTemporaryPassword();
    const hashedPassword = await hashPassword(data.password ?? generatedPassword!);
    const user = await userRepository.create({
      fullName: data.fullName,
      email: data.email,
      phone,
      ...(data.profile ? { profile: data.profile } : {}),
      passwordHash: hashedPassword,
      authProvider: AuthProvider.LOCAL,
      role: data.role,
      createdBy: new mongoose.Types.ObjectId(ownerId)
    });

    if (generatedPassword) {
      try {
        await sendCredentialsEmail(data.email, data.fullName, data.role, generatedPassword);
      } catch (err) {
        // The account is useless if nobody can learn its password: undo it so the person can try again
        await userRepository.deleteById(String(user._id)).catch(() => {});
        throw { statusCode: 502, message: 'The account could not be created because the login email could not be sent. Please try again.' };
      }
    }

    return user;
  },

  async getUsers(
    actor: Actor,
    role?: string,
    includeInactive = false,
    options: { page?: number; limit?: number; search?: string; organizerId?: string } = {}
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

    // An admin looking at one organizer's staff: the same list that organizer sees
    if (actor.role === Role.ADMIN && options.organizerId && mongoose.Types.ObjectId.isValid(options.organizerId)) {
      query.role = Role.SYSTEM_USER;
      query._id = { $in: await staffVisibleToOrganizer(options.organizerId) };
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
    if (actor.role === Role.ORGANIZER) await assertOrganizerOwnsStaff(actor.userId, target);
    await assertNotLastAdmin(target);
    const user = await userRepository.updateById(userId, { isActive: false });
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }
    await tokenRepository.revokeAllForUser(userId);
    if ((target as any).isActive !== false) await auditStateChange(actor, target, false, 'DELETE');
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
    const target = await findManageableUser(actor, userId);
    if (actor.role === Role.ORGANIZER) await assertOrganizerOwnsStaff(actor.userId, target);

    const updatePayload: any = {};
    if (data.fullName !== undefined) updatePayload.fullName = data.fullName;
    if (data.email !== undefined) {
      const email = String(data.email).toLowerCase().trim();
      // the same rules as when the account was created: an admin's email is never shared; one organizer per email; one listing of a
      // person per organizer's staff
      if (target.role === Role.ADMIN && (await User.exists({ email, _id: { $ne: userId } }))) {
        throw { statusCode: 409, message: 'This email address is already used by another account, so it cannot be an administrator account.' };
      }
      if (target.role !== Role.ADMIN && (await User.exists({ email, role: Role.ADMIN }))) {
        throw { statusCode: 409, message: 'This email address belongs to an administrator account, so it cannot be used for another account.' };
      }
      if (target.role === Role.ORGANIZER && (await User.exists({ email, role: Role.ORGANIZER, _id: { $ne: userId } }))) {
        throw { statusCode: 409, message: 'An organizer account already uses this email address.' };
      }
      if (target.role === Role.SYSTEM_USER && (await User.exists({ email, role: Role.SYSTEM_USER, createdBy: (target as any).createdBy, isActive: { $ne: false }, _id: { $ne: userId } }))) {
        throw { statusCode: 409, message: 'This person is already one of your system users.' };
      }
      updatePayload.email = data.email;
    }
    if (data.phone !== undefined) {
      updatePayload.phone = normalizePhoneNumber(data.phone);
    }
    if (data.isActive !== undefined) {
      if (actor.role === Role.ADMIN) {
        if (data.isActive === false) await assertNotLastAdmin(target);
        updatePayload.isActive = data.isActive;
      } else if (data.isActive === false) {
        // An organizer may take their own staff member off (the same effect as Remove: signed out, no access, history and assignments
        // kept). The ownership check above has already run, and an organizer can only reach staff accounts.
        updatePayload.isActive = false;
      } else {
        // Bringing an account back is an administrator's call; an organizer adds the person again instead. Say so rather than answer
        // "200" and leave the account as it was.
        throw { statusCode: 403, message: 'Only an administrator can reactivate an account. To bring a removed staff member back, add them again.' };
      }
    }
    // Only the organizer details an admin manages; the rest of the profile (avatar, etc.) is left as is
    if (data.profile && actor.role === Role.ADMIN) {
      if ((data.profile as any).organizationType !== undefined) updatePayload['profile.organizationType'] = (data.profile as any).organizationType;
      if (data.profile.organizationName !== undefined) updatePayload['profile.organizationName'] = data.profile.organizationName;
      // an individual has no organization name: switching to Individual clears it
      if ((data.profile as any).organizationType === 'INDIVIDUAL') updatePayload['profile.organizationName'] = '';
      if ((data.profile as any).invitationChannel !== undefined) updatePayload['profile.invitationChannel'] = (data.profile as any).invitationChannel;
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
    if (updatePayload.isActive !== undefined && (target as any).isActive !== updatePayload.isActive) {
      await auditStateChange(actor, target, updatePayload.isActive, 'PATCH');
    }
    // an administrator changed an organizer's account: the organizer is told what kind of change it was
    if (actor.role === Role.ADMIN && target.role === Role.ORGANIZER && String(actor.userId) !== String(userId)) {
      const changed = [
        data.fullName !== undefined ? 'name' : null,
        data.email !== undefined ? 'email address' : null,
        data.phone !== undefined ? 'phone number' : null,
        data.profile ? 'organisation details' : null,
        data.password ? 'password' : null,
        updatePayload.isActive === true && (target as any).isActive === false ? 'access (your account was reactivated)' : null
      ].filter(Boolean) as string[];
      if (changed.length > 0) {
        await (await import('./alert.service')).alertService.notifyUser(userId, {
          type: 'ACCOUNT',
          title: 'An administrator updated your account',
          message: `An administrator changed your ${changed.join(', ')}. If you did not expect this, contact the administrator.`,
          entityType: 'User',
          entityId: userId
        });
      }
    }
    return user;
  }
};
