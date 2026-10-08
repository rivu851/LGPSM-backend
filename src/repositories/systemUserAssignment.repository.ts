import { SystemUserAssignment, ISystemUserAssignment } from '../models/SystemUserAssignment';

export const systemUserAssignmentRepository = {
  async create(data: Partial<ISystemUserAssignment>): Promise<ISystemUserAssignment> {
    const assignment = new SystemUserAssignment(data);
    const saved = await assignment.save();
    return (await SystemUserAssignment.findById(saved._id)
      .populate('userId', 'fullName email phone role')
      .populate('sessionIds', 'name schedule')
      .populate('assignedBy', 'fullName email')
      .populate('eventId', 'title status schedule')) as ISystemUserAssignment;
  },

  async findByEventId(eventId: string): Promise<ISystemUserAssignment[]> {
    return await SystemUserAssignment.find({ eventId })
      .populate('userId', 'fullName email phone role')
      .populate('sessionIds', 'name schedule')
      .populate('assignedBy', 'fullName email')
      .populate('eventId', 'title status schedule');
  },

  async findByUserId(userId: string): Promise<ISystemUserAssignment[]> {
    return await SystemUserAssignment.find({ userId })
      .populate('eventId', 'title status format location schedule organizerId')
      .populate('sessionIds', 'name schedule')
      .populate('assignedBy', 'fullName email');
  },

  async findById(assignmentId: string): Promise<ISystemUserAssignment | null> {
    return await SystemUserAssignment.findById(assignmentId);
  },

  async findByUserAndEvent(userId: string, eventId: string): Promise<ISystemUserAssignment | null> {
    return await SystemUserAssignment.findOne({ userId, eventId });
  },

  async update(assignmentId: string, data: Partial<ISystemUserAssignment>): Promise<ISystemUserAssignment | null> {
    return await SystemUserAssignment.findByIdAndUpdate(assignmentId, data, { new: true, runValidators: true })
      .populate('userId', 'fullName email phone role')
      .populate('sessionIds', 'name schedule')
      .populate('assignedBy', 'fullName email')
      .populate('eventId', 'title status schedule');
  },

  async delete(assignmentId: string): Promise<ISystemUserAssignment | null> {
    return await SystemUserAssignment.findByIdAndDelete(assignmentId);
  }
};
