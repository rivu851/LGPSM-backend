import { Event, IEvent } from '../models/Event';
import { User, Role } from '../models/User';
import { SystemUserAssignment } from '../models/SystemUserAssignment';

// Event lookup for management operations: admins can manage any event, organizers only their own.
// When the caller's role is not known it is read from the user record.
export async function getUserRole(userId: string): Promise<string | undefined> {
  return (await User.findById(userId).select('role').lean())?.role;
}

export async function findManageableEvent(eventId: string, actorId: string, role?: string | null): Promise<IEvent | null> {
  const effectiveRole = role ?? (await getUserRole(actorId));

  if (effectiveRole === Role.ADMIN) {
    return Event.findById(eventId);
  }

  if (effectiveRole === Role.SYSTEM_USER) {
    // Staff (read-only callers) can access events they're assigned to for check-in duty
    const assignment = await SystemUserAssignment.findOne({ userId: actorId, eventId });
    return assignment ? Event.findById(eventId) : null;
  }

  return Event.findOne({ _id: eventId, organizerId: actorId });
}
