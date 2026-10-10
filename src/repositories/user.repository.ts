import { User, IUser, Role, AuthProvider } from '../models/User';

export const userRepository = {
  async findByEmail(email: string): Promise<IUser | null> {
    return User.findOne({ email });
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

  /**
   * Updates a user matched by email address.
   * Used by the email-verification flow (updateByEmail happens before the
   * user has a session, so we can't rely on an ID).
   */
  async updateByEmail(email: string, updateData: Partial<IUser>): Promise<IUser | null> {
    return User.findOneAndUpdate({ email }, updateData, { new: true, runValidators: true });
  },

  /**
   * Hard-deletes a user by email.  Called by the registration rollback path
   * when SMTP delivery fails, ensuring no orphaned inactive accounts remain.
   */
  async deleteByEmail(email: string): Promise<void> {
    await User.deleteOne({ email });
  },

  async find(query: any = {}): Promise<IUser[]> {
    return User.find(query).select('-passwordHash').sort({ createdAt: -1 });
  },
};
