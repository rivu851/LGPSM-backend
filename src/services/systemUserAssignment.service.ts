import { systemUserAssignmentRepository } from '../repositories/systemUserAssignment.repository';
import { ISystemUserAssignment } from '../models/SystemUserAssignment';
import { Event } from '../models/Event';
import { User, Role } from '../models/User';
import { Session } from '../models/Session';
import { staffVisibleToOrganizer } from './user.service';
import { findManageableEvent, getUserRole } from '../utils/eventAccess';
import { getInvitationCounts } from '../repositories/event.repository';
import mongoose from 'mongoose';

// Populate only selects a handful of Event fields (title/status/format/location/
// schedule/organizerId) — invitationsSent is computed on the fly, same as the
// events-list endpoint, so the mobile "Number of invites" figure isn't stuck
// showing nothing for every assignment.
async function withInvitationsSent(assignments: ISystemUserAssignment[]): Promise<any[]> {
  const plain = assignments.map((a: any) => (typeof a.toObject === 'function' ? a.toObject() : a));
  const eventIds = plain
    .map((a) => a.eventId && typeof a.eventId === 'object' ? a.eventId._id : null)
    .filter((id): id is mongoose.Types.ObjectId => !!id);
  const counts = await getInvitationCounts(eventIds);
  plain.forEach((a) => {
    if (a.eventId && typeof a.eventId === 'object') {
      a.eventId.invitationsSent = counts.get(String(a.eventId._id)) || 0;
    }
  });
  return plain;
}

const findAccessibleEvent = (eventId: string, actorId: string) => findManageableEvent(eventId, actorId);

export const systemUserAssignmentService = {
  async createAssignment(eventId: string, organizerId: string, data: { userId: string; sessionIds: string[] }): Promise<ISystemUserAssignment> {
    const event = await findAccessibleEvent(eventId, organizerId);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    // Staff are not assigned to an event that no longer takes place: it would look like live work on their phone
    if ((event as any).status === 'CANCELLED') {
      throw new Error('EVENT_CANCELLED');
    }

    const targetUser = await User.findById(data.userId);
    if (!targetUser || !targetUser.isActive || targetUser.role !== Role.SYSTEM_USER) {
      throw new Error('INVALID_USER');
    }
    // Organizers can only assign their own staff
    if ((await getUserRole(organizerId)) === Role.ORGANIZER) {
      const visible = await staffVisibleToOrganizer(organizerId);
      if (!visible.some((id) => String(id) === data.userId)) throw new Error('INVALID_USER');
    }

    const existing = await systemUserAssignmentRepository.findByUserAndEvent(data.userId, eventId);
    if (existing) {
      throw new Error('DUPLICATE_ASSIGNMENT');
    }

    // Verify sessions belong to event
    const uniqueSessionIds = [...new Set(data.sessionIds)];
    if (uniqueSessionIds.length > 0) {
      const sessions = await Session.find({ _id: { $in: uniqueSessionIds }, eventId });
      if (sessions.length !== uniqueSessionIds.length) {
        throw new Error('INVALID_SESSIONS');
      }
    }

    const assignmentData = {
      userId: new mongoose.Types.ObjectId(data.userId),
      eventId: new mongoose.Types.ObjectId(eventId),
      sessionIds: uniqueSessionIds.map(id => new mongoose.Types.ObjectId(id)),
      assignedBy: new mongoose.Types.ObjectId(organizerId)
    };

    return await systemUserAssignmentRepository.create(assignmentData);
  },

  async getAssignmentsByEvent(eventId: string, organizerId: string) {
    const event = await findAccessibleEvent(eventId, organizerId);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    return await systemUserAssignmentRepository.findByEventId(eventId);
  },

  async getAssignmentsByUser(userId: string, actor: { userId: string; role: Role }) {
    const assignments = await systemUserAssignmentRepository.findByUserId(userId);
    const withCounts = await withInvitationsSent(assignments);
    if (actor.role === Role.ORGANIZER) {
      // Organizers only see this staff member's assignments on their own events
      return withCounts.filter((a: any) => {
        const event = a.eventId;
        const eventOrganizerId = event && typeof event === 'object' ? event.organizerId : null;
        return eventOrganizerId && String(eventOrganizerId) === actor.userId;
      });
    }
    return withCounts;
  },

  async updateAssignment(assignmentId: string, organizerId: string, sessionIds: string[]): Promise<ISystemUserAssignment> {
    const assignment = await systemUserAssignmentRepository.findById(assignmentId);
    if (!assignment) {
      throw new Error('ASSIGNMENT_NOT_FOUND');
    }

    const event = await findAccessibleEvent(assignment.eventId.toString(), organizerId);
    if (!event) {
      throw new Error('ASSIGNMENT_NOT_FOUND');
    }

    const uniqueSessionIds = [...new Set(sessionIds)];
    if (uniqueSessionIds.length > 0) {
      const sessions = await Session.find({ _id: { $in: uniqueSessionIds }, eventId: assignment.eventId });
      if (sessions.length !== uniqueSessionIds.length) {
        throw new Error('INVALID_SESSIONS');
      }
    }

    const updated = await systemUserAssignmentRepository.update(assignmentId, {
      sessionIds: uniqueSessionIds.map(id => new mongoose.Types.ObjectId(id))
    });

    if (!updated) {
      throw new Error('UPDATE_FAILED');
    }
    return updated;
  },

  async deleteAssignment(assignmentId: string, organizerId: string): Promise<ISystemUserAssignment> {
    const assignment = await systemUserAssignmentRepository.findById(assignmentId);
    if (!assignment) {
      throw new Error('ASSIGNMENT_NOT_FOUND');
    }

    const event = await findAccessibleEvent(assignment.eventId.toString(), organizerId);
    if (!event) {
      throw new Error('ASSIGNMENT_NOT_FOUND');
    }

    const deleted = await systemUserAssignmentRepository.delete(assignmentId);
    if (!deleted) {
      throw new Error('DELETE_FAILED');
    }
    return deleted;
  }
};
