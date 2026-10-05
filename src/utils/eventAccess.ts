import { Event, IEvent } from '../models/Event';
import { User, Role } from '../models/User';

// Event lookup for management operations: admins can manage any event, organizers only their own.
// When the caller's role is not known it is read from the user record.
export async function getUserRole(userId: string): Promise<string | undefined> {
  return (await User.findById(userId).select('role').lean())?.role;
}

export async function findManageableEvent(eventId: string, actorId: string, role?: string | null): Promise<IEvent | null> {
  const effectiveRole = role ?? (await getUserRole(actorId));
  return effectiveRole === Role.ADMIN
    ? Event.findById(eventId)
    : Event.findOne({ _id: eventId, organizerId: actorId });
}
