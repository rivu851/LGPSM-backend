"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canTransition = exports.eventHasEnded = void 0;
const Event_1 = require("../models/Event");
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
const TRANSITIONS = {
    [Event_1.EventStatus.DRAFT]: [Event_1.EventStatus.PUBLISHED, Event_1.EventStatus.CANCELLED],
    [Event_1.EventStatus.PUBLISHED]: [Event_1.EventStatus.COMPLETED, Event_1.EventStatus.CANCELLED],
    [Event_1.EventStatus.COMPLETED]: [],
    [Event_1.EventStatus.CANCELLED]: []
};
/**
 * An event is over once it was closed, or once its end time has passed: nobody has to press anything. Entry and QR passes
 * already stop at that moment (the admission window); this is the same test for the rules that wait until an event is over.
 */
const eventHasEnded = (event, now = new Date()) => {
    if (event.status === Event_1.EventStatus.COMPLETED)
        return true;
    if (event.status !== Event_1.EventStatus.PUBLISHED)
        return false;
    const end = event.schedule?.end ? new Date(event.schedule.end) : null;
    return !!end && !Number.isNaN(end.getTime()) && end.getTime() <= now.getTime();
};
exports.eventHasEnded = eventHasEnded;
const canTransition = (from, to) => TRANSITIONS[from]?.includes(to) ?? false;
exports.canTransition = canTransition;
