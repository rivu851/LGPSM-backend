import mongoose from 'mongoose';
import { Invitee, IInvitee } from '../models/Invitee';
import { CheckIn } from '../models/CheckIn';

export const inviteeRepository = {
  /**
   * Same as findByEventId/countByEventId, but also joins each invitee against
   * the checkins collection (scoped to `sessionId` when given) so check-in
   * status can be filtered and paginated server-side instead of requiring the
   * caller to fetch every invitee and every check-in record to cross-reference
   * them in memory.
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
    const matchStage: any = { eventId: new mongoose.Types.ObjectId(eventId), ...(options.filter || {}) };

    const checkInMatch: any = { $expr: { $eq: ['$inviteeId', '$$inviteeId'] } };
    if (options.sessionId) {
      checkInMatch.sessionId = new mongoose.Types.ObjectId(options.sessionId);
    }

    const pipeline: any[] = [
      { $match: matchStage },
      {
        $lookup: {
          from: CheckIn.collection.name,
          let: { inviteeId: '$_id' },
          pipeline: [{ $match: checkInMatch }, { $sort: { checkInAt: -1 } }, { $limit: 1 }],
          as: 'checkInRecord',
        },
      },
      {
        $addFields: {
          isCheckedIn: { $gt: [{ $size: '$checkInRecord' }, 0] },
          checkedInAt: { $arrayElemAt: ['$checkInRecord.checkInAt', 0] },
        },
      },
    ];

    if (options.checkInStatus) {
      pipeline.push({ $match: { isCheckedIn: options.checkInStatus === 'CHECKED_IN' } });
    }

    pipeline.push({
      $facet: {
        data: [
          { $sort: options.sort || { createdAt: -1 } },
          { $skip: options.skip || 0 },
          { $limit: options.limit || 25 },
          { $project: { checkInRecord: 0 } },
        ],
        totalCount: [{ $count: 'count' }],
      },
    });

    const [result] = await Invitee.aggregate(pipeline);
    const invitees = result?.data || [];
    const total = result?.totalCount?.[0]?.count || 0;
    return { invitees, total };
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
    return await Invitee.findByIdAndUpdate(inviteeId, data, { new: true, runValidators: true });
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
