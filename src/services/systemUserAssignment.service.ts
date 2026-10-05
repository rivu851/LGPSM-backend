import { systemUserAssignmentRepository } from '../repositories/systemUserAssignment.repository';
import { ISystemUserAssignment } from '../models/SystemUserAssignment';
import { Event } from '../models/Event';
import { User, Role } from '../models/User';
import { Session } from '../models/Session';
import { staffVisibleToOrganizer } from './user.service';
import { findManageableEvent, getUserRole } from '../utils/eventAccess';
import mongoose from 'mongoose';

const findAccessibleEvent = (eventId: string, actorId: string) => findManageableEvent(eventId, actorId);

export const systemUserAssignmentService = {
  async createAssignment(eventId: string, organizerId: string, data: { userId: string; sessionIds: string[] }): Promise<ISystemUserAssignment> {
    const event = await findAccessibleEvent(eventId, organizerId);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
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

  async getAssignmentsByUser(userId: string) {
    return await systemUserAssignmentRepository.findByUserId(userId);
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
