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

export const canTransition = (from: EventStatus, to: EventStatus): boolean => TRANSITIONS[from]?.includes(to) ?? false;
