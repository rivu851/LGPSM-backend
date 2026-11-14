"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QR_SLOTS = exports.LOCATION_SLOTS = exports.DATE_SLOTS = exports.TITLE_SLOTS = exports.CARD_DISPLAY_DEFAULTS = void 0;
exports.cardDisplayOf = cardDisplayOf;
exports.withoutHidden = withoutHidden;
exports.CARD_DISPLAY_DEFAULTS = { title: true, qr: true, dateTime: true, location: true, inviteeName: true, logo: true };
function cardDisplayOf(raw) {
    const r = raw || {};
    return {
        title: r.title !== false,
        qr: r.qr !== false,
        dateTime: r.dateTime !== false,
        location: r.location !== false,
        inviteeName: r.inviteeName !== false,
        logo: r.logo !== false,
    };
}
/** The text slots of the fixed designs and the text roles of custom designs, by the detail they print */
exports.TITLE_SLOTS = ['title', 'names', 'honoree'];
exports.DATE_SLOTS = ['datePill', 'timeLine', 'day', 'month', 'year', 'weekday', 'time', 'date', 'dateTime'];
exports.LOCATION_SLOTS = ['address', 'venue'];
exports.QR_SLOTS = ['scanLabel'];
/** The texts a card should print, with the hidden details removed */
function withoutHidden(texts, show) {
    const drop = new Set([...(show.title ? [] : exports.TITLE_SLOTS), ...(show.dateTime ? [] : exports.DATE_SLOTS), ...(show.location ? [] : exports.LOCATION_SLOTS), ...(show.qr ? [] : exports.QR_SLOTS)]);
    return Object.fromEntries(Object.entries(texts).filter(([k]) => !drop.has(k)));
}
