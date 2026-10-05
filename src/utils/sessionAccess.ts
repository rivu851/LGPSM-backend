import { InviteeSource } from '../models/Session';

interface SessionLike {
  _id: unknown;
  inviteeSource?: string;
  sourceSessionId?: unknown;
}

interface InviteeLike {
  sessionAccess?: { sessionId: unknown; allowed?: boolean }[];
}

// A session that keeps the same invitees as another session ("COPY_SESSION") has no invitee list of
// its own: access is decided by the source session's list.
export function accessSessionIdFor(session: SessionLike): string {
  if (session.inviteeSource === InviteeSource.COPY_SESSION && session.sourceSessionId) {
    return String(session.sourceSessionId);
  }
  return String(session._id);
}

// Invitees without explicit session rules may attend every session
export function inviteeAllowedInSession(invitee: InviteeLike, session: SessionLike): boolean {
  if (!invitee.sessionAccess || invitee.sessionAccess.length === 0) return true;
  const target = accessSessionIdFor(session);
  const entry = invitee.sessionAccess.find((sa) => String(sa.sessionId) === target);
  return !!entry && entry.allowed !== false;
}

// MongoDB filter for invitees allowed into a session (used for counts)
export function inviteesAllowedFilter(session: SessionLike) {
  const target = accessSessionIdFor(session);
  return {
    $or: [
      { sessionAccess: { $size: 0 } },
      { sessionAccess: { $elemMatch: { sessionId: target, allowed: true } } }
    ]
  };
}
