"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatCardTime = exports.formatCardWeekday = exports.formatCardDate = void 0;
exports.buildInvitationContent = buildInvitationContent;
exports.startOfTodayInAppZone = startOfTodayInAppZone;
const env_1 = require("../config/env");
const sessionAccess_1 = require("./sessionAccess");
// Server-rendered dates (cards, emails, WhatsApp) use the platform time zone, never the host's.
const format = (d, options) => new Intl.DateTimeFormat('en-US', { timeZone: env_1.env.APP_TIMEZONE, ...options }).format(d);
const formatCardDate = (d) => format(d, { year: 'numeric', month: 'short', day: '2-digit' }).toUpperCase();
exports.formatCardDate = formatCardDate;
const formatCardWeekday = (d) => format(d, { weekday: 'long' }).toUpperCase();
exports.formatCardWeekday = formatCardWeekday;
const formatCardTime = (d) => format(d, { hour: '2-digit', minute: '2-digit', hour12: true });
exports.formatCardTime = formatCardTime;
// Event and session details printed on an invitation. Missing information stays empty rather than
// being replaced with sample values.
function buildInvitationContent(event, allSessions, invitee) {
    const start = event.schedule?.start ? new Date(event.schedule.start) : null;
    const isVirtual = event.format === 'VIRTUAL';
    const loc = (event.location || {});
    const sessions = allSessions
        .filter((s) => (invitee ? (0, sessionAccess_1.inviteeAllowedInSession)(invitee, s) : true))
        .map((s) => ({
        id: String(s._id),
        name: s.name,
        startTime: s.schedule?.start ? (0, exports.formatCardTime)(new Date(s.schedule.start)) : '',
        endTime: s.schedule?.end ? (0, exports.formatCardTime)(new Date(s.schedule.end)) : undefined
    }));
    return {
        eventDate: start ? (0, exports.formatCardDate)(start) : '',
        dayOfWeek: start ? (0, exports.formatCardWeekday)(start) : '',
        eventTime: start ? (0, exports.formatCardTime)(start) : '',
        venue: isVirtual ? 'ONLINE EVENT' : (event.location?.address || ''),
        locationSub: isVirtual ? '' : String(loc.city || loc.state || ''),
        sessions
    };
}
// Start of the current day in the platform time zone, as a UTC instant
function startOfTodayInAppZone(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: env_1.env.APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .formatToParts(now)
        .map((p) => [p.type, p.value]));
    // Offset of the zone at this moment = wall clock (as if UTC) minus the real instant
    const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const offsetMs = wallAsUtc - Math.floor(now.getTime() / 1000) * 1000;
    return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offsetMs);
}
