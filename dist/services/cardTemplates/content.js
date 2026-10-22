"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ordinal = ordinal;
exports.shortDateRange = shortDateRange;
exports.longDate = longDate;
exports.deriveSubject = deriveSubject;
exports.initialsOf = initialsOf;
exports.buildTemplateTexts = buildTemplateTexts;
exports.photoInitials = photoInitials;
exports.buildSpecTexts = buildSpecTexts;
const env_1 = require("../../config/env");
// ---- dates (platform time zone, never the server's) ----
const fmt = (d, options) => new Intl.DateTimeFormat('en-US', { timeZone: env_1.env.APP_TIMEZONE, ...options }).format(d).replace(/[  ]/g, ' ');
function parts(d) {
    return {
        day: fmt(d, { day: '2-digit' }),
        dayNumber: Number(fmt(d, { day: 'numeric' })),
        month2: fmt(d, { month: '2-digit' }),
        monthLong: fmt(d, { month: 'long' }),
        monthShort: fmt(d, { month: 'short' }),
        year: fmt(d, { year: 'numeric' }),
        year2: fmt(d, { year: '2-digit' }),
        weekday: fmt(d, { weekday: 'long' }),
        time: fmt(d, { hour: 'numeric', minute: '2-digit', hour12: true }),
    };
}
function ordinal(n) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13)
        return `${n}th`;
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}
const toDate = (v) => {
    if (!v)
        return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};
const sameDay = (a, b) => fmt(a, { dateStyle: 'short' }) === fmt(b, { dateStyle: 'short' });
/** "2nd Nov" for one day, "2nd Nov to 5th Nov" across days (the year is added when the range crosses years). */
function shortDateRange(start, end) {
    if (!start)
        return '';
    const s = parts(start);
    const first = `${ordinal(s.dayNumber)} ${s.monthShort}`;
    if (!end || sameDay(start, end))
        return first;
    const e = parts(end);
    const crossYear = s.year !== e.year;
    return `${first}${crossYear ? ` ${s.year}` : ''} to ${ordinal(e.dayNumber)} ${e.monthShort}${crossYear ? ` ${e.year}` : ''}`;
}
/** "2nd November, 2026", or "2nd - 5th November, 2026" across days of one month. */
function longDate(start, end) {
    if (!start)
        return '';
    const s = parts(start);
    if (!end || sameDay(start, end))
        return `${ordinal(s.dayNumber)} ${s.monthLong}, ${s.year}`;
    const e = parts(end);
    if (s.monthLong === e.monthLong && s.year === e.year)
        return `${ordinal(s.dayNumber)} - ${ordinal(e.dayNumber)} ${s.monthLong}, ${s.year}`;
    return `${ordinal(s.dayNumber)} ${s.monthShort} - ${ordinal(e.dayNumber)} ${e.monthShort}, ${e.year}`;
}
// ---- wording ----
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The people an event is about, taken from its title: "Moloy Birthday Celebration!!!" -> "Moloy",
 * "Moloy Roy & Dola Kar Wedding Reception" -> "Moloy Roy & Dola Kar". The title is kept as is when nothing is left.
 */
function deriveSubject(title, occasionWords) {
    let text = ` ${title} `;
    for (const word of occasionWords) {
        text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}'’])${escapeRegex(word)}(?=$|[^\\p{L}\\p{N}'’])`, 'giu'), '$1 ');
    }
    text = text
        .replace(/[!?*#~_…]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(the|of|for|a|an|and|&)\s+/i, '')
        .replace(/\s+(the|of|for|a|an|and|&|-|,)$/i, '')
        .trim();
    return text.length >= 2 ? text : title.trim();
}
function initialsOf(text) {
    const letters = text
        .split(/[\s&]+/)
        .map((w) => Array.from(w).find((ch) => /\p{L}/u.test(ch)) || '')
        .filter(Boolean);
    return letters.slice(0, 2).join('').toUpperCase();
}
const BIRTHDAY_WORDS = ['birthday', 'bday', "b'day", 'b’day', 'party', 'celebration', 'celebrations', 'celebrate', 'bash', 'function', 'special', 'happy'];
const RICE_WORDS = ['rice ceremony', 'annaprasan', 'annaprashan', 'mukhe bhaat', 'mukhebhaat', 'first rice', 'ceremony', 'celebration', 'party', 'function'];
const WEDDING_WORDS = ['wedding', 'reception', 'marriage', 'engagement', 'ceremony', 'celebration', 'party', 'function', 'sangeet', 'haldi', 'mehendi', 'mehndi', 'anniversary', 'ring', 'sagai', 'invitation'];
function weddingSubline(text) {
    if (/(engagement|ring\s*ceremony|sagai|roka)/i.test(text))
        return 'are getting engaged';
    if (/anniversary/i.test(text))
        return 'are celebrating their anniversary';
    if (/reception/i.test(text))
        return 'invite you to their wedding reception';
    if (/(haldi|mehend|mehndi|sangeet|cocktail)/i.test(text))
        return 'invite you to celebrate';
    return 'are getting married';
}
function addressLine(input) {
    if (input.isVirtual)
        return 'Online event';
    const venue = (input.venue || '').trim();
    const sub = (input.locationSub || '').trim();
    if (!venue)
        return sub;
    return sub && !venue.toLowerCase().includes(sub.toLowerCase()) ? `${venue}, ${sub}` : venue;
}
/** A short place name for tight spots: the city when known, otherwise the last parts of the address. */
function shortPlace(input) {
    if (input.isVirtual)
        return 'Online event';
    if (input.locationSub && input.locationSub.trim())
        return input.locationSub.trim();
    const segments = (input.venue || '').split(',').map((s) => s.trim()).filter(Boolean);
    return segments.slice(-2).join(', ');
}
/** Text for every slot of the design. Slots with nothing to say are left out and stay empty on the card. */
function buildTemplateTexts(input) {
    const start = toDate(input.startIso);
    const end = toDate(input.endIso);
    const p = start ? parts(start) : null;
    const kind = `${input.subcategoryName || ''} ${input.categoryName || ''} ${input.title}`;
    const scanLabel = 'Scan the QR code';
    const guest = (input.invitee?.name || '').trim();
    const company = (input.invitee?.companyName || '').trim();
    const employeeId = (input.invitee?.employeeId || '').trim();
    switch (input.design) {
        case 'CORPORATE_V1':
            return {
                title: input.title,
                inviteeName: guest,
                inviteeMeta: employeeId ? `Employee ID #${employeeId}` : company,
                datePill: start ? `Event Date${end && !sameDay(start, end) ? 's' : ''}: ${longDate(start, end)}` : '',
                address: addressLine(input),
            };
        case 'CORPORATE_V2':
            return {
                title: input.title,
                inviteeName: guest,
                inviteeMeta: company,
                scanLabel,
                datePill: shortDateRange(start, end),
                address: shortPlace(input),
            };
        case 'WEDDING':
            return {
                names: deriveSubject(input.title, WEDDING_WORDS),
                subline: weddingSubline(kind),
                timeLine: p ? `${p.weekday}, ${p.time}` : '',
                day: p?.day || '',
                month: p?.month2 || '',
                year: p?.year2 || '',
                scanLabel,
                address: addressLine(input),
            };
        case 'RICE_CEREMONY':
            return {
                heading: /annaprasan|annaprashan/i.test(input.subcategoryName || '') ? input.subcategoryName.trim() : 'Rice Ceremony',
                subline: 'of our beloved child',
                honoree: deriveSubject(input.title, RICE_WORDS),
                scanLabel,
                timeLine: p ? `${p.weekday}, ${p.time.toLowerCase()}` : '',
                day: p?.day || '',
                month: p?.month2 || '',
                year: p?.year2 || '',
                address: addressLine(input),
            };
        case 'BIRTHDAY':
            return {
                intro: 'Please Join us to celebrate',
                honoree: deriveSubject(input.title, BIRTHDAY_WORDS),
                // "Birthday Party" unless the organizer's subcategory says something more specific ("First Birthday", "Birthday Bash")
                heading: /birthday|bday/i.test(input.subcategoryName || '') && (input.subcategoryName || '').trim().split(/\s+/).length > 1 ? input.subcategoryName.trim() : 'Birthday Party',
                scanLabel,
                month: p?.monthLong || '',
                weekday: p?.weekday || '',
                day: p?.day || '',
                time: p ? `At ${p.time}` : '',
                address: addressLine(input),
            };
    }
}
/** Initials for the photo frame when no picture was uploaded: the guest of honour, or the event title. */
function photoInitials(input, texts) {
    return initialsOf(texts.honoree || texts.names || input.title);
}
/** Text for every role a custom design can show. Roles with nothing to say are omitted so the design leaves them empty. */
function buildSpecTexts(input) {
    const start = toDate(input.startIso);
    const end = toDate(input.endIso);
    const p = start ? parts(start) : null;
    const clean = (v) => (v || '').trim();
    const texts = {
        title: clean(input.title),
        description: clean(input.description),
        date: start ? longDate(start, end) : '',
        time: p ? (end && sameDay(start, end) ? `${p.time} – ${parts(end).time}` : p.time) : '',
        dateTime: p ? `${p.weekday}, ${longDate(start, end)} · ${p.time}` : '',
        venue: addressLine({ design: 'CORPORATE_V1', title: '', venue: input.venue, locationSub: input.locationSub, isVirtual: input.isVirtual }),
        organizer: clean(input.organizerName),
        inviteeName: clean(input.invitee?.name),
        inviteeMeta: clean(input.invitee?.employeeId ? `Employee ID #${input.invitee.employeeId}` : input.invitee?.companyName),
        tagline: ''
    };
    return Object.fromEntries(Object.entries(texts).filter(([, v]) => v));
}
