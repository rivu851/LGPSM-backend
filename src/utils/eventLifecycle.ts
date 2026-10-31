import { EventStatus } from '../models/Event';

/**
 * Server-side event lifecycle. Status is never taken from a client request body: it only changes through the
 * explicit operations below (close, cancel), each of which checks the transition here.
 *
 *   DRAFT      -> PUBLISHED | CANCELLED
 *   PUBLISHED  -> COMPLETED | CANCELLED
 *   COMPLETED  -> (terminal; history is kept)
 *   CANCELLED  -> (terminal)
 *
 * Events are created PUBLISHED today (DRAFT is not reachable from the UI yet), so DRAFT -> PUBLISHED is listed for
 * the later publish phase and is not exposed by an endpoint.
 */
const TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  [EventStatus.DRAFT]: [EventStatus.PUBLISHED, EventStatus.CANCELLED],
  [EventStatus.PUBLISHED]: [EventStatus.COMPLETED, EventStatus.CANCELLED],
  [EventStatus.COMPLETED]: [],
  [EventStatus.CANCELLED]: []
};

/**
 * An event is over once it was closed, or once its end time has passed: nobody has to press anything. Entry and QR passes
 * already stop at that moment (the admission window); this is the same test for the rules that wait until an event is over.
 */
export const eventHasEnded = (event: { status?: string; schedule?: { end?: Date | string | null } | null }, now: Date = new Date()): boolean => {
  if (event.status === EventStatus.COMPLETED) return true;
  if (event.status !== EventStatus.PUBLISHED) return false;
  const end = event.schedule?.end ? new Date(event.schedule.end) : null;
  return !!end && !Number.isNaN(end.getTime()) && end.getTime() <= now.getTime();
};

export const canTransition = (from: EventStatus, to: EventStatus): boolean => TRANSITIONS[from]?.includes(to) ?? false;
