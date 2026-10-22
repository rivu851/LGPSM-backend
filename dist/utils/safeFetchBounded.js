"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BoundedFetchError = void 0;
exports.hostAllowed = hostAllowed;
exports.fetchBounded = fetchBounded;
const https_1 = __importDefault(require("https"));
const net_1 = __importDefault(require("net"));
const safeFetch_1 = require("./safeFetch");
class BoundedFetchError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
exports.BoundedFetchError = BoundedFetchError;
function hostAllowed(host, suffixes) {
    const h = host.toLowerCase().replace(/\.$/, '');
    return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
}
function fetchBounded(rawUrl, options, hops = 0) {
    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(rawUrl);
        }
        catch {
            return reject(new BoundedFetchError('URL_NOT_ALLOWED', 'Invalid URL'));
        }
        const bare = url.hostname.replace(/^\[|\]$/g, '');
        if (url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            (url.port && url.port !== '443') ||
            (net_1.default.isIP(bare) && (0, safeFetch_1.isPrivateAddress)(bare)) ||
            !hostAllowed(url.hostname, options.hostSuffixes)) {
            return reject(new BoundedFetchError('URL_NOT_ALLOWED', 'URL is not allowed'));
        }
        const req = https_1.default.get(url, { lookup: safeFetch_1.guardedLookup, timeout: options.timeoutMs ?? 15000, headers: { 'User-Agent': 'LGPSM-template-importer', Accept: '*/*' } }, (res) => {
            const status = res.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                res.resume();
                if (hops >= (options.maxRedirects ?? 3))
                    return reject(new BoundedFetchError('BAD_STATUS', 'Too many redirects'));
                let next;
                try {
                    next = new URL(res.headers.location, url).toString();
                }
                catch {
                    return reject(new BoundedFetchError('URL_NOT_ALLOWED', 'Invalid redirect'));
                }
                return fetchBounded(next, options, hops + 1).then(resolve, reject);
            }
            if (status !== 200) {
                res.resume();
                return reject(new BoundedFetchError('BAD_STATUS', `Unexpected response ${status}`));
            }
            const declared = Number(res.headers['content-length']);
            if (Number.isFinite(declared) && declared > options.maxBytes) {
                res.resume();
                return reject(new BoundedFetchError('TOO_LARGE', 'Download is too large'));
            }
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > options.maxBytes)
                    return req.destroy(new BoundedFetchError('TOO_LARGE', 'Download is too large'));
                chunks.push(chunk);
            });
            res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() }));
            res.on('error', (e) => reject(new BoundedFetchError('NETWORK', e.message)));
        });
        req.on('timeout', () => req.destroy(new BoundedFetchError('TIMEOUT', 'Request timed out')));
        req.on('error', (e) => reject(e instanceof BoundedFetchError ? e : new BoundedFetchError('NETWORK', e.message)));
    });
}
