import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { config } from '../config.js';
import { AppError } from './errors.js';

/** Reject anything that is not a public unicast address (loopback, RFC1918, link-local, CGNAT, metadata, etc.). */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

export class UnsafeUrlError extends AppError {
  constructor(message: string) {
    super(422, 'UNSAFE_URL', message);
  }
}

export function normalizeFeedUrl(raw: string): URL {
  let value = raw.trim();
  if (value.toLowerCase().startsWith('webcal://')) value = 'https://' + value.slice('webcal://'.length);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError('Not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UnsafeUrlError('Only http(s) and webcal URLs are allowed');
  if (url.username || url.password) throw new UnsafeUrlError('Credentials in URLs are not allowed');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new UnsafeUrlError('Port not allowed');
  return url;
}

async function assertHostIsPublic(hostname: string): Promise<void> {
  if (config.ALLOW_PRIVATE_ICS_HOSTS) return;
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new UnsafeUrlError('Host could not be resolved');
  for (const a of addresses) {
    if (!isPublicAddress(a.address)) throw new UnsafeUrlError('URL resolves to a private or reserved address');
  }
}

/** DNS lookup used at connect time, re-validating the address to prevent DNS rebinding. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  import('node:dns').then((dns) =>
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as unknown as { address: string; family: number }[];
      const safe = config.ALLOW_PRIVATE_ICS_HOSTS ? list : list.filter((a) => isPublicAddress(a.address));
      const first = safe[0];
      if (!first) return callback(new UnsafeUrlError('URL resolves to a private or reserved address'), '', 0);
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof safe) => void)(null, safe);
      callback(null, first.address, first.family);
    }),
  );
};

export interface SafeFetchResult {
  status: number;
  body: string;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}

export async function safeFetchText(
  rawUrl: string,
  opts: { maxBytes?: number; timeoutMs?: number; etag?: string | null; maxRedirects?: number } = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15000;
  let url = normalizeFeedUrl(rawUrl);
  for (let redirects = 0; redirects <= (opts.maxRedirects ?? 3); redirects++) {
    await assertHostIsPublic(url.hostname);
    const res = await requestOnce(url, maxBytes, timeoutMs, opts.etag ?? null);
    if (res.redirect) {
      url = normalizeFeedUrl(new URL(res.redirect, url).toString());
      continue;
    }
    return res.result!;
  }
  throw new UnsafeUrlError('Too many redirects');
}

function requestOnce(
  url: URL,
  maxBytes: number,
  timeoutMs: number,
  etag: string | null,
): Promise<{ redirect?: string; result?: SafeFetchResult }> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'FamilyHubPro/1.0 (+calendar-subscription)',
          Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && status !== 304 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          return reject(new AppError(422, 'FEED_TOO_LARGE', 'Calendar feed is too large'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new AppError(422, 'FEED_TOO_LARGE', 'Calendar feed is too large'));
          } else chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            result: {
              status,
              body: Buffer.concat(chunks).toString('utf8'),
              etag: (res.headers.etag as string) ?? null,
              lastModified: (res.headers['last-modified'] as string) ?? null,
              notModified: status === 304,
            },
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new AppError(504, 'FEED_TIMEOUT', 'Calendar feed timed out')));
    req.on('error', reject);
    req.end();
  });
}
