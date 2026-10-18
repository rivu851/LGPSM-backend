"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPrivateAddress = isPrivateAddress;
exports.fetchPublicImage = fetchPublicImage;
const dns_1 = __importDefault(require("dns"));
const https_1 = __importDefault(require("https"));
const net_1 = __importDefault(require("net"));
// Fetches an image from a URL that an end user supplied (for example an organizer photo) without
// letting the server be pointed at its own network. Guards:
//  - https only, default port only, no credentials in the URL
//  - the destination address is validated at connect time (not only before it), so DNS rebinding
//    and hostnames that resolve to private ranges are rejected
//  - redirects are never followed
//  - hard limits on time and size, and only JPEG/PNG/WEBP content is accepted
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 5000;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
function ipv4ToInt(ip) {
    return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}
const BLOCKED_V4 = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];
function isPrivateAddress(address) {
    if (net_1.default.isIPv4(address)) {
        const value = ipv4ToInt(address);
        return BLOCKED_V4.some(([base, bits]) => {
            const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
            return (value & mask) === (ipv4ToInt(base) & mask);
        });
    }
    if (net_1.default.isIPv6(address)) {
        const lower = address.toLowerCase();
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped)
            return isPrivateAddress(mapped[1]);
        return (lower === '::' || lower === '::1' ||
            lower.startsWith('fc') || lower.startsWith('fd') || // unique local
            /^fe[89ab]/.test(lower) || // link local
            lower.startsWith('ff') || // multicast
            lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8'));
    }
    return true; // not an IP at all: refuse
}
// Used as the socket `lookup`, so the address that is actually connected to is the one checked
const guardedLookup = ((hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    dns_1.default.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err)
            return cb(err);
        const list = addresses;
        const safe = list.filter((a) => !isPrivateAddress(a.address));
        if (list.length === 0 || safe.length !== list.length) {
            return cb(new Error('Destination address is not allowed'));
        }
        const chosen = safe[0];
        if (options && typeof options === 'object' && options.all)
            return cb(null, safe);
        return cb(null, chosen.address, chosen.family);
    });
});
function fetchPublicImage(rawUrl) {
    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(rawUrl);
        }
        catch {
            return reject(new Error('Invalid URL'));
        }
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
            return reject(new Error('URL is not allowed'));
        }
        if (net_1.default.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
            return reject(new Error('Destination address is not allowed'));
        }
        const req = https_1.default.get(url, { lookup: guardedLookup, timeout: TIMEOUT_MS, headers: { Accept: ALLOWED_TYPES.join(', '), 'User-Agent': 'LGPSM-card-renderer' } }, (res) => {
            const status = res.statusCode ?? 0;
            const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (status !== 200) {
                res.resume();
                return reject(new Error(`Unexpected response ${status}`)); // includes redirects
            }
            if (!ALLOWED_TYPES.includes(contentType)) {
                res.resume();
                return reject(new Error('Unsupported content type'));
            }
            const declared = Number(res.headers['content-length']);
            if (Number.isFinite(declared) && declared > MAX_BYTES) {
                res.resume();
                return reject(new Error('Image is too large'));
            }
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_BYTES) {
                    req.destroy(new Error('Image is too large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve({ contentType, buffer: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
    });
}
