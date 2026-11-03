"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queryString = exports.OBJECT_ID_PATTERN = void 0;
exports.queryObjectId = queryObjectId;
exports.pageParams = pageParams;
// Query strings are attacker-controlled and Express hands over an array when a name is repeated (?a=1&a=2), so nothing reads
// req.query directly as a string. Page sizes are bounded here so one request cannot pull a whole collection.
exports.OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
/** The value when it is a non-empty string; undefined for anything else. */
const queryString = (value) => (typeof value === 'string' && value !== '' ? value : undefined);
exports.queryString = queryString;
/** A valid ObjectId string, undefined when absent, and a 400 when present but malformed. */
function queryObjectId(value, name) {
    const text = (0, exports.queryString)(value);
    if (text === undefined)
        return undefined;
    if (!exports.OBJECT_ID_PATTERN.test(text))
        throw { statusCode: 400, message: `Invalid ${name} format` };
    return text;
}
function pageParams(query, defaults) {
    const page = Math.max(parseInt(String(query.page ?? ''), 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(String(query.limit ?? ''), 10) || defaults.limit, 1), defaults.max);
    return { page, limit };
}
