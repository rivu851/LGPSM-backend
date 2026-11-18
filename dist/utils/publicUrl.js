"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicApiUrl = void 0;
const env_1 = require("../config/env");
/**
 * This API's public address with no trailing slash, or null when it is not known. PUBLIC_API_URL when set; otherwise the address
 * Render gives every web service (RENDER_EXTERNAL_URL), so emails link their images even if the setting was forgotten there.
 */
const publicApiUrl = () => {
    const v = (env_1.env.PUBLIC_API_URL || process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(v) ? v : null;
};
exports.publicApiUrl = publicApiUrl;
