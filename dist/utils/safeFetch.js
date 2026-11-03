"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.guardedLookup = void 0;
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
/** The eight 16-bit groups of an IPv6 address in any notation (compressed, or with a dotted IPv4 tail); null when it does not parse. */
function ipv6Groups(address) {
    let text = address.toLowerCase().split('%')[0];
    const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) {
        if (!net_1.default.isIPv4(dotted[2]))
            return null;
        const v = ipv4ToInt(dotted[2]);
        text = `${dotted[1]}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
    }
    const [head, tail, ...rest] = text.split('::');
    if (rest.length)
        return null;
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    if (tail === undefined && left.length !== 8)
        return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0)
        return null;
    const groups = [...left, ...Array(tail === undefined ? 0 : fill).fill('0'), ...right].map((g) => parseInt(g, 16));
    return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}
const embeddedV4 = (high, low) => `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
function isPrivateAddress(address) {
    if (net_1.default.isIPv4(address)) {
        const value = ipv4ToInt(address);
        return BLOCKED_V4.some(([base, bits]) => {
            const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
            return (value & mask) === (ipv4ToInt(base) & mask);
        });
    }
    if (net_1.default.isIPv6(address)) {
        const g = ipv6Groups(address);
        if (!g)
            return true; // cannot be judged: refuse
        const leadingZeros = (n) => g.slice(0, n).every((v) => v === 0);
        // Addresses that carry an IPv4 address are judged by that address, however they were written (::ffff:7f00:1 is 127.0.0.1)
        if (leadingZeros(5) && g[5] === 0xffff)
            return isPrivateAddress(embeddedV4(g[6], g[7])); // mapped
        if (leadingZeros(6) && (g[6] !== 0 || g[7] > 1))
            return isPrivateAddress(embeddedV4(g[6], g[7])); // compatible (deprecated)
        if (g[0] === 0x2002)
            return isPrivateAddress(embeddedV4(g[1], g[2])); // 6to4
        return ((leadingZeros(7) && g[7] <= 1) || // :: and ::1
            (g[0] & 0xfe00) === 0xfc00 || // unique local
            (g[0] & 0xffc0) === 0xfe80 || // link local
            (g[0] & 0xffc0) === 0xfec0 || // site local (deprecated)
            (g[0] & 0xff00) === 0xff00 || // multicast
            (g[0] === 0x0064 && g[1] === 0xff9b) || // NAT64
            (g[0] === 0x2001 && g[1] === 0x0db8) || // documentation
            (g[0] === 0x2001 && g[1] === 0) // Teredo
        );
    }
    return true; // not an IP at all: refuse
}
// Used as the socket `lookup`, so the address that is actually connected to is the one checked
exports.guardedLookup = ((hostname, options, callback) => {
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
        const req = https_1.default.get(url, { lookup: exports.guardedLookup, timeout: TIMEOUT_MS, headers: { Accept: ALLOWED_TYPES.join(', '), 'User-Agent': 'LGPSM-card-renderer' } }, (res) => {
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
