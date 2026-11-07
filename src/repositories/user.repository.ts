import { User, IUser, Role, AuthProvider } from '../models/User';
import { normalizePhoneNumber } from '../services/whatsapp.service';

export const userRepository = {
  async findByEmail(email: string): Promise<IUser | null> {
    return User.findOne({ email });
  },

  async findAllByEmail(email: string): Promise<IUser[]> {
    return User.find({ email });
  },

  async findByRoleAndEmail(email: string, role: Role): Promise<IUser | null> {
    return User.findOne({ email, role });
  },

  /**
   * Looks up all accounts by normalized phone number via the indexed `phone`
   * field. Login resolves shared numbers using the password and requested role.
   */
  async findByPhone(rawPhone: string): Promise<IUser[]> {
    const normalized = normalizePhoneNumber(rawPhone);
    if (!normalized) return [];
    return User.find({ phone: normalized });
  },

  async findById(id: string): Promise<IUser | null> {
    return User.findById(id);
  },

  async create(data: Partial<IUser>): Promise<IUser> {
    const user = new User(data);
    return user.save();
  },

  async updateById(id: string, updateData: Partial<IUser>): Promise<IUser | null> {
    return User.findByIdAndUpdate(id, updateData, { new: true, runValidators: true });
  },

  async verifyOrganizerEmail(email: string): Promise<void> {
    await User.updateMany({ email, role: Role.ORGANIZER }, { $set: { isEmailVerified: true } });
  },

  async deleteById(id: string): Promise<void> {
    await User.deleteOne({ _id: id });
  },

  async find(query: any = {}): Promise<IUser[]> {
    return User.find(query).select('-passwordHash').sort({ createdAt: -1 });
  },

  async findPage(query: any, skip: number, limit: number): Promise<IUser[]> {
    return User.find(query)
      .select('-passwordHash')
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean<IUser[]>();
  },

  async count(query: any = {}): Promise<number> {
    return User.countDocuments(query);
  },
};
