import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';

interface ServiceAccount { project_id: string; client_email: string; private_key: string }
let account: ServiceAccount | null | undefined;
let token: { value: string; exp: number } | null = null;

function loadAccount() {
  if (account !== undefined) return account;
  try {
    account = config.FIREBASE_SERVICE_ACCOUNT_FILE ? (JSON.parse(readFileSync(config.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8')) as ServiceAccount) : null;
  } catch {
    account = null;
  }
  return account;
}

export const fcmConfigured = () => Boolean(loadAccount());

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** OAuth2 access token for FCM via a signed service-account JWT (no extra SDK). */
async function accessToken(sa: ServiceAccount) {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`FCM auth ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

/** Returns false when the device token is no longer valid (caller should delete it). */
export async function sendFcm(deviceToken: string, msg: { title: string; body: string; url: string; tag: string }) {
  const sa = loadAccount();
  if (!sa) return true;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(sa)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: msg.title, body: msg.body },
        data: { url: msg.url, tag: msg.tag },
        android: { priority: 'HIGH', notification: { tag: msg.tag, default_sound: true, channel_id: 'familyhub' } },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404 || res.status === 400) {
    const t = await res.text();
    if (/UNREGISTERED|INVALID_ARGUMENT/.test(t)) return false;
    throw new Error(`FCM ${res.status}: ${t.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`FCM ${res.status}`);
  return true;
}
