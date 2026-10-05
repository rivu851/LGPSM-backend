import { env } from '../config/env';
import { inviteeAllowedInSession } from './sessionAccess';

// Server-rendered dates (cards, emails, WhatsApp) use the platform time zone, never the host's.
const format = (d: Date, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: env.APP_TIMEZONE, ...options }).format(d);

export const formatCardDate = (d: Date) => format(d, { year: 'numeric', month: 'short', day: '2-digit' }).toUpperCase();
export const formatCardWeekday = (d: Date) => format(d, { weekday: 'long' }).toUpperCase();
export const formatCardTime = (d: Date) => format(d, { hour: '2-digit', minute: '2-digit', hour12: true });

interface EventLike {
  _id?: unknown;
  title: string;
  format?: string;
  location?: { address?: string } & Record<string, unknown>;
  schedule?: { start?: Date | string; end?: Date | string };
}

interface SessionLike {
  _id: unknown;
  name: string;
  inviteeSource?: string;
  sourceSessionId?: unknown;
  schedule?: { start?: Date | string; end?: Date | string };
}

// Event and session details printed on an invitation. Missing information stays empty rather than
// being replaced with sample values.
export function buildInvitationContent(
  event: EventLike,
  allSessions: SessionLike[],
  invitee: { sessionAccess?: { sessionId: unknown; allowed?: boolean }[] } | null
) {
  const start = event.schedule?.start ? new Date(event.schedule.start) : null;
  const isVirtual = event.format === 'VIRTUAL';
  const loc = (event.location || {}) as Record<string, unknown>;
  const sessions = allSessions
    .filter((s) => (invitee ? inviteeAllowedInSession(invitee, s) : true))
    .map((s) => ({
      id: String(s._id),
      name: s.name,
      startTime: s.schedule?.start ? formatCardTime(new Date(s.schedule.start)) : '',
      endTime: s.schedule?.end ? formatCardTime(new Date(s.schedule.end)) : undefined
    }));

  return {
    eventDate: start ? formatCardDate(start) : '',
    dayOfWeek: start ? formatCardWeekday(start) : '',
    eventTime: start ? formatCardTime(start) : '',
    venue: isVirtual ? 'ONLINE EVENT' : (event.location?.address || ''),
    locationSub: isVirtual ? '' : String(loc.city || loc.state || ''),
    sessions
  };
}

// Start of the current day in the platform time zone, as a UTC instant
export function startOfTodayInAppZone(now: Date = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: env.APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  // Offset of the zone at this moment = wall clock (as if UTC) minus the real instant
  const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = wallAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offsetMs);
}
