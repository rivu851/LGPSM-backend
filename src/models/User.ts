import mongoose, { Document, Schema } from 'mongoose';
import { userAuthCache } from '../utils/userAuthCache';

export enum Role {
  ADMIN = 'ADMIN',
  ORGANIZER = 'ORGANIZER',
  SYSTEM_USER = 'SYSTEM_USER'
}

export enum AuthProvider {
  LOCAL = 'LOCAL',
  GOOGLE = 'GOOGLE'
}

export interface IUser extends Document {
  fullName: string;
  email: string;
  phone?: string;
  passwordHash?: string;
  authProvider: AuthProvider;
  role: Role;
  profile?: Record<string, any>;
  createdBy?: mongoose.Types.ObjectId;
  isActive: boolean;
  /**
   * Email ownership has been confirmed via OTP.
   * — New ORGANIZER self-registrations start as false.
   * — ADMIN / SYSTEM_USER accounts and all pre-existing accounts default to true
   *   so that existing login/session flows are not affected.
   */
  isEmailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema: Schema = new Schema(
  {
    // Indexed (non-unique) so admin/organizer user search can sort/filter by
    // name without a full collection scan.
    fullName: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    // Stored in normalized form (see whatsapp.service.ts normalizePhoneNumber) so
    // phone-based login can do a direct indexed lookup instead of scanning the
    // collection. Not unique: existing data may still contain duplicates/legacy
    // raw formats — see src/scripts/normalizePhoneNumbers.ts for backfilling.
    phone: { type: String, index: true },
    passwordHash: { type: String },
    authProvider: { type: String, enum: Object.values(AuthProvider), default: AuthProvider.LOCAL },
    role: { type: String, enum: Object.values(Role), default: Role.ORGANIZER },
    profile: { type: Schema.Types.Mixed },
    // Who created this account (admins/organizers create staff); scopes which organizer sees it
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret: any) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      }
    }
  }
);

// A change to any account (role, active flag, removal) must show up on the next request, not after the auth cache expires
UserSchema.post(
  ['save', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'] as any,
  () => userAuthCache.clear()
);

// One organizer account per email, enforced by the database as well (two requests at once cannot both get through). Staff and admin
// accounts are outside this index: they may share an email with an organizer and with each other.
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { role: 'ORGANIZER' }, name: 'uniq_organizer_email' });

// One listing of a person per organizer's staff, enforced by the database as well: two requests at once (a double click, an admin and an
// organizer adding the same person) cannot both get through the check-then-insert in userService. The boundary is the organizer who owns
// the account (createdBy), so the same e-mail may still belong to staff of other organizers, to an organizer and to an admin; and a
// removed (inactive) account does not block adding the person again. Staff rows with no owner (not created by the app) are outside it.
UserSchema.index(
  { email: 1, createdBy: 1 },
  { unique: true, partialFilterExpression: { role: 'SYSTEM_USER', isActive: true, createdBy: { $type: 'objectId' } }, name: 'uniq_active_staff_per_owner' }
);

export const User = mongoose.model<IUser>('User', UserSchema);
