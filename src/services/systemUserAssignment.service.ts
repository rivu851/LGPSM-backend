import { systemUserAssignmentRepository } from '../repositories/systemUserAssignment.repository';
import { ISystemUserAssignment, SystemUserAssignment } from '../models/SystemUserAssignment';
import { Event } from '../models/Event';
import { User, Role } from '../models/User';
import { Session } from '../models/Session';
import { staffVisibleToOrganizer } from './user.service';
import { findManageableEvent, getUserRole } from '../utils/eventAccess';
import { getInvitationCounts } from '../repositories/event.repository';
import mongoose from 'mongoose';
import { assertEventOpenForChanges } from '../utils/eventLifecycle';
import { alertService } from './alert.service';

/** The assignments of an event whose person is still active: a deactivated or deleted staff account is not "assigned" any more in any count */
export async function activeAssignmentsOf(eventId: unknown, select = 'userId sessionIds'): Promise<any[]> {
  const rows: any[] = await SystemUserAssignment.find({ eventId }, select).lean();
  if (rows.length === 0) return rows;
  const active = new Set((await User.find({ _id: { $in: rows.map((r) => r.userId) }, isActive: { $ne: false } }).select('_id').lean()).map((u: any) => String(u._id)));
  return rows.filter((r) => active.has(String(r.userId)));
}

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
    assertEventOpenForChanges(event);

    const targetUser = await User.findById(data.userId);
    if (!targetUser || !targetUser.isActive) {
      throw new Error('INVALID_USER');
    }
    // Only a system user, the event's own organizer, or the person making the assignment (an organizer or administrator working the event
    // themselves) can be assigned: never some other organizer or administrator
    if (targetUser.role !== Role.SYSTEM_USER && String(targetUser._id) !== String((event as any).organizerId) && String(targetUser._id) !== organizerId) {
      throw new Error('INVALID_USER');
    }
    // Organizers can assign themselves or staff visible to their organization.
    if ((await getUserRole(organizerId)) === Role.ORGANIZER && data.userId !== organizerId) {
      const visible = await staffVisibleToOrganizer(organizerId);
      if (!visible.some((id) => String(id) === data.userId)) throw new Error('INVALID_USER');
    }

    // Switched off for now: a small event may be run entirely by its organizer, who then also works it as a system user (an organizer
    // and a system user may share an email). To bring back "the organizer of an event is not also its staff", restore this check
    // (matched by email, so it covers their organizer account and their system user account) and the IS_EVENT_ORGANIZER branch in
    // systemUserAssignment.controller.ts:
    //
    // const owner: any = await User.findById((event as any).organizerId);
    // const sameEmail = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
    // if (sameEmail(owner?.email, targetUser.email)) throw new Error('IS_EVENT_ORGANIZER');

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

    const created = await systemUserAssignmentRepository.create(assignmentData);
    await this.tellStaff(event, data.userId, uniqueSessionIds, 'ASSIGNED');
    return created;
  },

  async getAssignmentsByEvent(eventId: string, organizerId: string) {
    const event = await findAccessibleEvent(eventId, organizerId);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    return await systemUserAssignmentRepository.findByEventId(eventId);
  },

  /**
   * Staff of this event's organizer who are already assigned to another of that organizer's events running at the same time
   * (the two time ranges overlap). Used to warn before the same person is put on two events at once; nothing is blocked.
   *
   * With `includeAll` it returns every assignment those staff hold on the organizer's OTHER (non-cancelled) events, each marked
   * with whether it overlaps this event in time, so a screen can show a person's real workload and the clash warning from one
   * dataset. `sessionIds` empty means all sessions of that event.
   */
  async overlapsForEvent(eventId: string, actorId: string, includeAll = false) {
    const event: any = await findAccessibleEvent(eventId, actorId);
    if (!event) throw new Error('EVENT_NOT_FOUND');
    const start = event.schedule?.start, end = event.schedule?.end;
    if (!includeAll && (!start || !end)) return [];
    const query: any = { organizerId: event.organizerId, _id: { $ne: event._id }, status: { $ne: 'CANCELLED' } };
    if (!includeAll) { query['schedule.start'] = { $lt: end }; query['schedule.end'] = { $gt: start }; }
    const others: any[] = await Event.find(query).select('title schedule').lean();
    if (!others.length) return [];
    const byId = new Map(others.map((e) => [String(e._id), e]));
    const assignments: any[] = await SystemUserAssignment.find({ eventId: { $in: others.map((e) => e._id) } }).select('userId eventId sessionIds').lean();
    return assignments.map((a) => {
      const e = byId.get(String(a.eventId))!;
      const overlaps = !!start && !!end && !!e.schedule?.start && !!e.schedule?.end && e.schedule.start < end && e.schedule.end > start;
      return {
        userId: String(a.userId), eventId: String(e._id), title: e.title, start: e.schedule?.start, end: e.schedule?.end,
        sessionIds: (a.sessionIds || []).map((id: any) => String(id)), overlaps
      };
    });
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
    assertEventOpenForChanges(event);

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
    await this.tellStaff(event, String(assignment.userId), uniqueSessionIds, 'CHANGED');
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
    assertEventOpenForChanges(event);

    const deleted = await systemUserAssignmentRepository.delete(assignmentId);
    if (!deleted) {
      throw new Error('DELETE_FAILED');
    }
    await this.tellStaff(event, String(assignment.userId), [], 'REMOVED');
    return deleted;
  },

  /** The staff member is told in the app when they are put on an event, when their sessions change, or when they are taken off it */
  async tellStaff(event: any, userId: string, sessionIds: string[], what: 'ASSIGNED' | 'CHANGED' | 'REMOVED') {
    // a notice never fails the assignment it is about
    try {
      // (an organizer working their own event does not need telling about their own action)
      const target: any = await User.findById(userId);
      if (!target || target.role !== Role.SYSTEM_USER) return;
      let where = 'all its sessions';
      if (sessionIds.length > 0) {
        const names = (await Session.find({ _id: { $in: sessionIds } })).map((s: any) => s.name);
        where = names.length ? names.join(', ') : `${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'}`;
      }
      const title = event.title || 'an event';
      const copy = {
        ASSIGNED: { title: 'You were assigned to an event', message: `You are now assigned to "${title}" (${where}).` },
        CHANGED: { title: 'Your assignment changed', message: `Your assignment on "${title}" now covers ${where}.` },
        REMOVED: { title: 'You were removed from an event', message: `You are no longer assigned to "${title}".` }
      }[what];
      // (not awaited: the assignment does not wait for the notice to be stored)
      void alertService.notifyUser(userId, { type: `STAFF_${what}`, entityType: 'Event', entityId: event._id, ...copy }).catch(() => undefined);
    } catch (err) {
      console.error('Staff notice failed:', (err as Error).message);
    }
  }
};
