"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicApiUrl = void 0;
const env_1 = require("../config/env");
/** This API's public address with no trailing slash, or null when PUBLIC_API_URL is not set (or is not an http(s) address). */
const publicApiUrl = () => {
    const v = (env_1.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(v) ? v : null;
};
exports.publicApiUrl = publicApiUrl;
