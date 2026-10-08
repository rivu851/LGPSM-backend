"use strict";
/**
 * Handles QR payload normalization and security validation for check-in entry points.
 *
 * Security Rationale:
 * - QR validation is strictly enforced to prevent arbitrary URL injection and phishing passes.
 * - Only URLs matching the configured invitation origin (`INVITATION_BASE_URL`) or canonical 64-hex tokens are accepted.
 * - Arbitrary domains, embedded credentials, and extra path segments are explicitly rejected.
 * - Unsent preview cards encode `PREVIEW_SAMPLE_SEGMENT` to distinguish dummy cards from live passes.
 * - Sensitive raw tokens are normalized without logging raw secret material.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewSampleUrl = exports.invitationUrlFor = exports.invitationBaseUrl = exports.PREVIEW_SAMPLE_SEGMENT = void 0;
exports.parseInvitationQrPayload = parseInvitationQrPayload;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
// Marker segment used on preview cards for guests who have not been sent an invitation yet.
exports.PREVIEW_SAMPLE_SEGMENT = 'preview-sample';
const invitationBaseUrl = () => (process.env.INVITATION_BASE_URL || `${process.env.FRONTEND_URL || ''}/invitation`).replace(/\/+$/, '');
exports.invitationBaseUrl = invitationBaseUrl;
const invitationUrlFor = (token) => `${(0, exports.invitationBaseUrl)()}/${token}`;
exports.invitationUrlFor = invitationUrlFor;
const previewSampleUrl = () => (0, exports.invitationUrlFor)(exports.PREVIEW_SAMPLE_SEGMENT);
exports.previewSampleUrl = previewSampleUrl;
/**
 * Accepts exactly two shapes:
 *  - a raw invitation token (64 hex chars)
 *  - an invitation URL whose origin and path prefix match the configured invitation base URL,
 *    followed by exactly one token segment (query string / fragment are ignored)
 * Anything else — other hosts, extra path segments, embedded credentials — is rejected.
 */
function parseInvitationQrPayload(input) {
    if (typeof input !== 'string')
        return { ok: false, reason: 'EMPTY' };
    const value = input.trim();
    if (!value)
        return { ok: false, reason: 'EMPTY' };
    if (TOKEN_PATTERN.test(value))
        return { ok: true, token: value.toLowerCase() };
    if (!/^https?:\/\//i.test(value))
        return { ok: false, reason: 'UNSUPPORTED_FORMAT' };
    let url;
    let base;
    try {
        url = new URL(value);
        base = new URL((0, exports.invitationBaseUrl)());
    }
    catch {
        return { ok: false, reason: 'UNSUPPORTED_FORMAT' };
    }
    if (url.username || url.password || url.origin !== base.origin)
        return { ok: false, reason: 'UNTRUSTED_URL' };
    const basePath = base.pathname.replace(/\/+$/, '');
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.startsWith(`${basePath}/`))
        return { ok: false, reason: 'UNTRUSTED_URL' };
    const segment = path.slice(basePath.length + 1);
    if (segment === exports.PREVIEW_SAMPLE_SEGMENT)
        return { ok: false, reason: 'PREVIEW_SAMPLE' };
    if (!TOKEN_PATTERN.test(segment))
        return { ok: false, reason: 'UNSUPPORTED_FORMAT' };
    return { ok: true, token: segment.toLowerCase() };
}
