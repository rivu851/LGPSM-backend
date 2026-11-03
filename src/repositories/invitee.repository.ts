import mongoose from 'mongoose';
import { Invitee, IInvitee } from '../models/Invitee';
import { CheckIn } from '../models/CheckIn';

export const inviteeRepository = {
  /**
   * One page of guests with each guest's check-in state (within `sessionId` when given). This runs after every door scan, so its cost must
   * not grow with the size of the guest list: the people who checked in are read first when the list is filtered by that, and only the
   * guests on the page are then looked up. (It used to join every guest of the event against the check-ins before taking one page.)
   */
  async findByEventIdWithCheckInStatus(
    eventId: string,
    options: {
      filter?: any;
      sessionId?: string;
      checkInStatus?: 'CHECKED_IN' | 'PENDING';
      sort?: any;
      skip?: number;
      limit?: number;
    } = {}
  ): Promise<{ invitees: (IInvitee & { isCheckedIn: boolean; checkedInAt: Date | null })[]; total: number }> {
    const eventObjectId = new mongoose.Types.ObjectId(eventId);
    const checkInScope: any = { eventId: eventObjectId };
    if (options.sessionId) checkInScope.sessionId = new mongoose.Types.ObjectId(options.sessionId);

    const match: any = { eventId: eventObjectId, ...(options.filter || {}) };
    if (options.checkInStatus) {
      const attended = await CheckIn.distinct('inviteeId', checkInScope);
      match._id = options.checkInStatus === 'CHECKED_IN' ? { $in: attended } : { $nin: attended };
    }

    const [rows, total] = await Promise.all([
      Invitee.find(match)
        .sort(options.sort || { createdAt: -1 })
        .skip(options.skip || 0)
        .limit(options.limit || 25)
        .lean(),
      Invitee.countDocuments(match),
    ]);

    const records = await CheckIn.find({ ...checkInScope, inviteeId: { $in: rows.map((r: any) => r._id) } })
      .select('inviteeId checkInAt')
      .sort({ checkInAt: 1 })
      .lean();
    // Ascending, so the latest check-in for a guest is the one that stays
    const latest = new Map<string, Date>(records.map((r: any) => [String(r.inviteeId), r.checkInAt]));
    const invitees = rows.map((r: any) => ({ ...r, isCheckedIn: latest.has(String(r._id)), checkedInAt: latest.get(String(r._id)) ?? undefined }));
    return { invitees: invitees as any, total };
  },
  async create(data: Partial<IInvitee>): Promise<IInvitee> {
    const invitee = new Invitee(data);
    return await invitee.save();
  },

  async insertMany(data: Partial<IInvitee>[]): Promise<IInvitee[]> {
    return await Invitee.insertMany(data) as any;
  },

  async findByEventId(eventId: string, options: { 
    filter?: any, 
    sort?: any, 
    skip?: number, 
    limit?: number 
  } = {}): Promise<IInvitee[]> {
    const filter = { eventId, ...(options.filter || {}) };
    let query = Invitee.find(filter);
    
    if (options.sort) {
      query = query.sort(options.sort);
    }
    if (options.skip !== undefined) {
      query = query.skip(options.skip);
    }
    if (options.limit !== undefined) {
      query = query.limit(options.limit);
    }
    return await query.exec();
  },

  async countByEventId(eventId: string, filter: any = {}): Promise<number> {
    return await Invitee.countDocuments({ eventId, ...filter });
  },

  async findById(inviteeId: string): Promise<IInvitee | null> {
    return await Invitee.findById(inviteeId);
  },

  async findByEmailOrMobile(eventId: string, email?: string, mobile?: string): Promise<IInvitee[]> {
    const orConditions: any[] = [];
    if (email) orConditions.push({ email: email.toLowerCase() });
    if (mobile) orConditions.push({ mobile });

    if (orConditions.length === 0) return [];

    return await Invitee.find({ eventId, $or: orConditions });
  },

  async update(inviteeId: string, data: Partial<IInvitee>): Promise<IInvitee | null> {
    // load + save (not findByIdAndUpdate) so that validation runs and the derived phone key stays in step with the phone number
    const doc = await Invitee.findById(inviteeId);
    if (!doc) return null;
    doc.set(data as any);
    return await doc.save();
  },

  async bulkUpdateSessionAccess(inviteeIds: string[], sessionAccess: any[]): Promise<any> {
    return await Invitee.updateMany(
      { _id: { $in: inviteeIds } },
      { $set: { sessionAccess } },
      { runValidators: true }
    );
  },

  async delete(inviteeId: string): Promise<IInvitee | null> {
    return await Invitee.findByIdAndDelete(inviteeId);
  }
};
