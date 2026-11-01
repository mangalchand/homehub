import { X509Certificate, createVerify } from 'node:crypto';
import { rootCertificates } from 'node:tls';

/** Alexa request verification for skills hosted as a web service (signature + timestamp). */
const MAX_SKEW_MS = 150_000;
const roots = rootCertificates.map((pem) => new X509Certificate(pem));
const cache = new Map<string, { certs: X509Certificate[]; until: number }>();

export function normalizeCertUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 's3.amazonaws.com' || u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  const path = u.pathname.replace(/\/{2,}/g, '/');
  if (!path.startsWith('/echo.api/')) return null;
  return `https://s3.amazonaws.com${path}`;
}

export function timestampFresh(timestamp: unknown, now = Date.now()) {
  const t = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  return Number.isFinite(t) && Math.abs(now - t) <= MAX_SKEW_MS;
}

export function parseChain(pem: string) {
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((p) => new X509Certificate(p));
}

export function chainTrusted(certs: X509Certificate[], now = new Date()) {
  const leaf = certs[0];
  if (!leaf) return false;
  if (new Date(leaf.validFrom) > now || new Date(leaf.validTo) < now) return false;
  if (!(leaf.subjectAltName ?? '').split(/,\s*/).includes('DNS:echo-api.amazon.com')) return false;
  for (let i = 0; i < certs.length - 1; i++) {
    const c = certs[i]!, issuer = certs[i + 1]!;
    if (!c.checkIssued(issuer) || !c.verify(issuer.publicKey)) return false;
    if (new Date(issuer.validTo) < now) return false;
  }
  const top = certs[certs.length - 1]!;
  return roots.some((r) => r.fingerprint256 === top.fingerprint256 || (top.checkIssued(r) && top.verify(r.publicKey)));
}

async function certChain(url: string) {
  const hit = cache.get(url);
  if (hit && hit.until > Date.now()) return hit.certs;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!res.ok) throw new Error('cert fetch failed');
  const certs = parseChain(await res.text());
  if (!chainTrusted(certs)) throw new Error('untrusted cert');
  cache.set(url, { certs, until: Math.min(Date.now() + 3_600_000, new Date(certs[0]!.validTo).getTime()) });
  return certs;
}

/** True only for a request signed by Alexa (Signature-256 over the raw body) with a fresh timestamp. */
export async function verifyAlexaRequest(headers: { certUrl?: string; signature?: string }, body: Buffer, timestamp: unknown) {
  if (!timestampFresh(timestamp)) return false;
  const url = normalizeCertUrl(headers.certUrl);
  if (!url || !headers.signature) return false;
  try {
    const [leaf] = await certChain(url);
    return createVerify('RSA-SHA256').update(body).verify(leaf!.publicKey, headers.signature, 'base64');
  } catch {
    return false;
  }
}
