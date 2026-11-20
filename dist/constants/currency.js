"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_RATE_PER_INVITEE = exports.PLATFORM_CURRENCY = void 0;
/**
 * The platform bills in Indian rupees. There is one currency: prices are stored as plain numbers and shown in rupees; nothing here
 * converts an amount. A settings or event record that still says another currency (an older default was USD) is shown and charged
 * as rupees without being rewritten, so no historical record is changed.
 */
exports.PLATFORM_CURRENCY = 'INR';
/** The per-invitee charge used until an administrator sets a rate (Settings > Price Rate); a rate that is set always wins. */
exports.DEFAULT_RATE_PER_INVITEE = 3;
