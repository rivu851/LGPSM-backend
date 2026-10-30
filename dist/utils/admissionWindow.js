"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.effectiveAdmission = effectiveAdmission;
exports.admissionState = admissionState;
exports.formatAdmissionTime = formatAdmissionTime;
exports.validateAdmissionInput = validateAdmissionInput;
const env_1 = require("../config/env");
const asDate = (v) => {
    if (v === null || v === undefined || v === '')
        return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};
function effectiveAdmission(event) {
    const explicitOpen = asDate(event.admission?.opensAt);
    const explicitClose = asDate(event.admission?.closesAt);
    const opensAt = explicitOpen ?? asDate(event.schedule?.start);
    const closesAt = explicitClose ?? asDate(event.schedule?.end);
    if (!opensAt || !closesAt)
        return null;
    return { opensAt, closesAt, opensAtIsDefault: !explicitOpen, closesAtIsDefault: !explicitClose };
}
function admissionState(window, now) {
    if (now.getTime() < window.opensAt.getTime())
        return 'NOT_OPEN';
    if (now.getTime() >= window.closesAt.getTime())
        return 'CLOSED';
    return 'OPEN';
}
/** "31 Oct 2026, 9:00 AM IST", written in the platform timezone so staff read the same wall-clock time as the organizer. */
function formatAdmissionTime(d) {
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: env_1.env.APP_TIMEZONE, day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
    }).format(d);
}
/** Rule for what an organizer may save. Returns an error message, or null when acceptable. */
function validateAdmissionInput(schedule, admission) {
    if (!admission)
        return null;
    for (const key of ['opensAt', 'closesAt']) {
        const raw = admission[key];
        if (raw !== null && raw !== undefined && raw !== '' && !asDate(raw))
            return 'Check-in times must be valid dates.';
    }
    const w = effectiveAdmission({ schedule, admission });
    if (!w)
        return null;
    if (w.opensAt.getTime() >= w.closesAt.getTime())
        return 'Check-in must open before it closes.';
    return null;
}
