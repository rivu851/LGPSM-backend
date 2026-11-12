/**
 * The platform bills in Indian rupees. There is one currency: prices are stored as plain numbers and shown in rupees; nothing here
 * converts an amount. A settings or event record that still says another currency (an older default was USD) is shown and charged
 * as rupees without being rewritten, so no historical record is changed.
 */
export const PLATFORM_CURRENCY = 'INR';
