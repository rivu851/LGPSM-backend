import https from 'https';
import net from 'net';
import { guardedLookup, isPrivateAddress } from './safeFetch';

// Downloads a provider artifact (generated HTML, a preview image) with the same guarantees as fetchPublicImage - https
// only, destination checked at connect time, hard size and time limits - for URLs that come from a trusted provider
// but are still treated as untrusted: the host must belong to an allow-list, and redirects (which download links
// commonly use) are followed only while every hop stays on the allow-list.

export interface BoundedFetchOptions {
  hostSuffixes: string[];
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export class BoundedFetchError extends Error {
  constructor(public readonly code: 'URL_NOT_ALLOWED' | 'TOO_LARGE' | 'TIMEOUT' | 'BAD_STATUS' | 'NETWORK', message: string) {
    super(message);
  }
}

export function hostAllowed(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
}

export function fetchBounded(rawUrl: string, options: BoundedFetchOptions, hops = 0): Promise<{ buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return reject(new BoundedFetchError('URL_NOT_ALLOWED', 'Invalid URL'));
    }
    const bare = url.hostname.replace(/^\[|\]$/g, '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      (net.isIP(bare) && isPrivateAddress(bare)) ||
      !hostAllowed(url.hostname, options.hostSuffixes)
    ) {
      return reject(new BoundedFetchError('URL_NOT_ALLOWED', 'URL is not allowed'));
    }

    const req = https.get(url, { lookup: guardedLookup as any, timeout: options.timeoutMs ?? 15000, headers: { 'User-Agent': 'LGPSM-template-importer', Accept: '*/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (hops >= (options.maxRedirects ?? 3)) return reject(new BoundedFetchError('BAD_STATUS', 'Too many redirects'));
        let next: string;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
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
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) return req.destroy(new BoundedFetchError('TOO_LARGE', 'Download is too large'));
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() }));
      res.on('error', (e) => reject(new BoundedFetchError('NETWORK', e.message)));
    });
    req.on('timeout', () => req.destroy(new BoundedFetchError('TIMEOUT', 'Request timed out')));
    req.on('error', (e) => reject(e instanceof BoundedFetchError ? e : new BoundedFetchError('NETWORK', e.message)));
  });
}
