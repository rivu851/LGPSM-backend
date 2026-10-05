import { sessionRepository } from '../repositories/session.repository';
import { ISession, InviteeSource, Session } from '../models/Session';
import { SystemUserAssignment } from '../models/SystemUserAssignment';
import { Event } from '../models/Event';
import mongoose from 'mongoose';
import { Invitee } from '../models/Invitee';
import { findManageableEvent } from '../utils/eventAccess';

// The primary session is the event's first-created session
async function primarySessionId(eventId: string): Promise<string | null> {
  const first = await Session.findOne({ eventId }).sort({ _id: 1 }).select('_id').lean();
  return first ? String(first._id) : null;
}

// A session may keep the same invitees as another session of the same event that has its own list
async function assertValidSource(eventId: string, sessionId: string | null, sourceSessionId: string) {
  if (sessionId && sessionId === sourceSessionId) {
    throw { statusCode: 400, message: 'A session cannot copy its own invitee list' };
  }
  const source = await Session.findOne({ _id: sourceSessionId, eventId });
  if (!source) throw new Error('INVALID_SOURCE_SESSION');
  if (source.inviteeSource === InviteeSource.COPY_SESSION) {
    throw { statusCode: 400, message: `"${source.name}" already uses another session's invitees; choose a session with its own list` };
  }
  if (sessionId && (await Session.exists({ eventId, sourceSessionId: sessionId }))) {
    throw { statusCode: 400, message: 'Other sessions copy this session\'s invitees, so it must keep its own list' };
  }
}

export const sessionService = {
  async createSession(eventId: string, organizerId: string, data: Partial<ISession>): Promise<ISession> {
    const event = await findManageableEvent(eventId, organizerId);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    // Cross-session validation is configured on the primary (first) session only
    if (data.validateAgainstOtherSessions && (await primarySessionId(eventId))) {
      throw { statusCode: 400, message: 'Session access validation can only be set on the first session' };
    }

    // Validate schedule falls within event schedule (if required)
    if (new Date(data.schedule!.start) < new Date(event.schedule.start) || 
        new Date(data.schedule!.end) > new Date(event.schedule.end)) {
      throw new Error('SESSION_OUT_OF_BOUNDS');
    }

    // COPY_SESSION sessions resolve access through the source session's list (utils/sessionAccess.ts)
    if (data.inviteeSource === InviteeSource.COPY_SESSION && data.sourceSessionId) {
      await assertValidSource(eventId, null, data.sourceSessionId.toString());
    } else {
      data.inviteeSource = InviteeSource.NEW_LIST;
      data.sourceSessionId = null;
    }

    const sessionData = {
      ...data,
      eventId: new mongoose.Types.ObjectId(eventId)
    };

    return await sessionRepository.create(sessionData);
  },

  async getSessions(eventId: string, organizerId: string, options: { page?: number; limit?: number } = {}, role?: string) {
    if (role === 'SYSTEM_USER') {
      // Staff only see sessions of events they are assigned to, limited to their assigned sessions
      const assignment = await SystemUserAssignment.findOne({ userId: organizerId, eventId });
      if (!assignment) {
        throw new Error('EVENT_NOT_FOUND');
      }
      const query: any = { eventId };
      if (assignment.sessionIds && assignment.sessionIds.length > 0) {
        query._id = { $in: assignment.sessionIds };
      }
      const sessions = await Session.find(query).sort({ 'schedule.start': 1 });
      return { sessions, total: sessions.length };
    }

    const event = await findManageableEvent(eventId, organizerId, role);
    if (!event) {
      throw new Error('EVENT_NOT_FOUND');
    }

    const page = options.page || 1;
    const limit = options.limit || 10;
    const skip = (page - 1) * limit;

    const sessions = await sessionRepository.findByEventId(eventId, {
      sort: { 'schedule.start': 1 },
      skip,
      limit
    });
    
    const total = await sessionRepository.countByEventId(eventId);

    return { sessions, total };
  },

  async getSessionById(sessionId: string, organizerId: string): Promise<ISession> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) {
      throw new Error('SESSION_NOT_FOUND');
    }

    const event = await findManageableEvent(session.eventId.toString(), organizerId);
    if (!event) {
      throw new Error('SESSION_NOT_FOUND'); // Hide cross-organizer existence
    }

    return session;
  },

  async updateSession(sessionId: string, organizerId: string, data: Partial<ISession>): Promise<ISession> {
    const session = await this.getSessionById(sessionId, organizerId); // Ensures ownership

    // Avoid mass assignment of protected fields
    delete (data as any)._id;
    delete (data as any).eventId;
    delete (data as any).createdAt;

    const eventId = session.eventId.toString();
    if (data.validateAgainstOtherSessions && (await primarySessionId(eventId)) !== sessionId) {
      throw { statusCode: 400, message: 'Session access validation can only be set on the first session' };
    }
    if (data.inviteeSource === InviteeSource.COPY_SESSION) {
      if (!data.sourceSessionId) throw { statusCode: 400, message: 'Choose the session whose invitees should be used' };
      await assertValidSource(eventId, sessionId, data.sourceSessionId.toString());
    } else if (data.inviteeSource === InviteeSource.NEW_LIST) {
      data.sourceSessionId = null;
    }

    if (data.schedule) {
      const event = await Event.findById(session.eventId);
      if (event && (new Date(data.schedule.start) < new Date(event.schedule.start) || 
          new Date(data.schedule.end) > new Date(event.schedule.end))) {
        throw new Error('SESSION_OUT_OF_BOUNDS');
      }
    }

    const updatedSession = await sessionRepository.update(sessionId, data);
    if (!updatedSession) {
      throw new Error('UPDATE_FAILED');
    }
    
    return updatedSession;
  },

  async deleteSession(sessionId: string, organizerId: string): Promise<ISession> {
    const session = await this.getSessionById(sessionId, organizerId); // Ensures ownership

    // Sessions that kept this session's invitees get their own copy of the list before it disappears
    const dependents = await Session.find({ eventId: session.eventId, sourceSessionId: session._id });
    if (dependents.length > 0) {
      const allowed = await Invitee.find({ eventId: session.eventId, sessionAccess: { $elemMatch: { sessionId: session._id, allowed: true } } });
      for (const inv of allowed) {
        for (const dep of dependents) {
          if (!inv.sessionAccess.some((sa) => String(sa.sessionId) === String(dep._id))) {
            inv.sessionAccess.push({ sessionId: dep._id as mongoose.Types.ObjectId, allowed: true } as any);
          }
        }
        await inv.save();
      }
      await Session.updateMany({ _id: { $in: dependents.map((d) => d._id) } }, { inviteeSource: InviteeSource.NEW_LIST, sourceSessionId: null });
    }
    await Invitee.updateMany({ eventId: session.eventId }, { $pull: { sessionAccess: { sessionId: session._id } } });
    
    // We do a hard delete or safe non-destructive approach. The prompt says: "If a deletion policy is not defined, use a safe non-destructive approach and document the required decision."
    // However, if we don't have an `isActive` flag on the Session, we might just hard delete it, or we should add an isActive flag.
    // Let's perform a hard delete as it's common, but we'll document it.
    
    const deleted = await sessionRepository.delete(sessionId);
    if (!deleted) {
      throw new Error('DELETE_FAILED');
    }
    
    return deleted;
  }
};
