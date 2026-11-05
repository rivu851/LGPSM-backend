"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.coverageOfDesign = void 0;
exports.coverageOfSpec = coverageOfSpec;
exports.contactForCard = contactForCard;
exports.whenText = whenText;
exports.detailRows = detailRows;
const content_1 = require("./content");
const NONE = { title: false, date: false, time: false, endTime: false, location: false, guest: false, meta: false };
const ALL = { title: true, date: true, time: true, endTime: true, location: true, guest: true, meta: true };
/** What each fixed design's artwork prints (read from its slots in layouts.generated.ts) */
const FIXED = {
    CORPORATE_V1: { ...NONE, title: true, date: true, location: true, guest: true, meta: true },
    CORPORATE_V2: { ...NONE, title: true, date: true, location: true, guest: true, meta: true },
    WEDDING: { ...NONE, title: true, date: true, time: true, endTime: true, location: true },
    RICE_CEREMONY: { ...NONE, title: true, date: true, time: true, endTime: true, location: true },
    BIRTHDAY: { ...NONE, title: true, date: true, time: true, endTime: true, location: true },
    CLASSIC: ALL
};
/** A designed (AI/custom) or uploaded specification covers exactly the text roles it contains */
function coverageOfSpec(spec) {
    const roles = new Set(spec.elements.filter((e) => e.type === 'text').map((e) => e.role));
    const dateTime = roles.has('dateTime');
    return {
        // an uploaded picture carries its own wording, so its title is left alone; the rest of the event's facts are added below it
        title: roles.has('title') || spec.meta.generator === 'UPLOAD',
        date: roles.has('date') || dateTime,
        time: roles.has('time') || dateTime,
        endTime: roles.has('time'),
        location: roles.has('venue'),
        guest: roles.has('inviteeName'),
        meta: roles.has('inviteeMeta')
    };
}
const coverageOfDesign = (design) => FIXED[design] || NONE;
exports.coverageOfDesign = coverageOfDesign;
/**
 * The contact number as it goes on the card. The Add Event form shows a fixed +91 in front of the field and stores only what was
 * typed, so the country code is added here: "9007000891" -> "+91 90070 00891". A number typed with its own "+" is left as typed.
 */
function contactForCard(raw) {
    const typed = (raw || '').trim().replace(/\s+/g, ' ');
    if (!typed || typed.startsWith('+'))
        return typed;
    let digits = typed.replace(/\D/g, '');
    if (!digits)
        return typed;
    if (digits.length === 12 && digits.startsWith('91'))
        digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0'))
        digits = digits.slice(1);
    return digits.length === 10 ? `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` : `+91 ${digits}`;
}
const short = (d) => { const p = (0, content_1.parts)(d); return `${p.weekday.slice(0, 3)}, ${p.dayNumber} ${p.monthShort} ${p.year}`; };
/**
 * The date and time wording for exactly the part the artwork does not already show.
 * - The artwork shows the start date and time: only the end is stated, explicitly ("Ends …").
 * - Otherwise both ends are stated in full, so nothing has to be guessed from half a picture.
 */
function whenText(input, covered) {
    const start = (0, content_1.toDate)(input.startIso);
    if (!start)
        return '';
    const end = (0, content_1.toDate)(input.endIso);
    const s = (0, content_1.parts)(start);
    const ranged = !!end && end > start;
    const e = ranged ? (0, content_1.parts)(end) : null;
    const same = ranged && (0, content_1.sameDay)(start, end);
    if (covered.date && covered.time) {
        if (!ranged)
            return '';
        if (same)
            return covered.endTime ? '' : `Ends ${e.time}`;
        // across days no slot holds the end, so it is always stated
        return `Ends ${e.weekday}, ${(0, content_1.ordinal)(e.dayNumber)} ${e.monthLong} ${e.year}, ${e.time}`;
    }
    const first = `${s.weekday}, ${(0, content_1.ordinal)(s.dayNumber)} ${s.monthLong} ${s.year} · ${s.time}`;
    if (!ranged)
        return first;
    return same ? `${first} – ${e.time}` : `${short(start)}, ${s.time} – ${short(end)}, ${e.time}`;
}
/** Everything the event has to say that this template's artwork does not already print, in reading order */
function detailRows(input, covered) {
    const rows = [];
    const add = (kind, text) => { const t = (text || '').trim(); if (t)
        rows.push({ kind, text: t }); };
    if (!covered.title)
        add('title', input.title);
    add('when', whenText(input, covered));
    if (!covered.location)
        add('where', (0, content_1.addressLine)({ design: 'CORPORATE_V1', title: '', venue: input.venue, locationSub: input.locationSub, isVirtual: input.isVirtual }));
    if (!covered.guest)
        add('name', input.guestName);
    if (!covered.meta)
        add('meta', input.guestMeta);
    add('contact', contactForCard(input.contactNumber));
    return rows;
}
