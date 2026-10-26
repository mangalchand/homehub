import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';
import type { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { realtime } from './realtime.js';
import { fcmConfigured, sendFcm } from './fcm.js';

export interface MemberNotificationPrefs {
  push?: boolean;
  whatsapp?: boolean;
  whatsappNumber?: string;
  muted?: string[];
}

export function notificationPrefs(preferences: unknown): MemberNotificationPrefs {
  const p = (preferences as { notifications?: MemberNotificationPrefs } | null)?.notifications ?? {};
  return { push: p.push ?? true, whatsapp: p.whatsapp ?? false, whatsappNumber: p.whatsappNumber ?? '', muted: p.muted ?? [] };
}

// ---- Web Push keys -------------------------------------------------------------
let vapid: { publicKey: string; privateKey: string } | null = null;
export async function vapidKeys() {
  if (vapid) return vapid;
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY };
  } else {
    const file = path.resolve(config.UPLOAD_DIR, '.vapid.json');
    try {
      vapid = JSON.parse(await readFile(file, 'utf8')) as { publicKey: string; privateKey: string };
    } catch {
      vapid = webpush.generateVAPIDKeys();
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(vapid), { mode: 0o600 });
      logger.info('generated Web Push VAPID keys');
    }
  }
  webpush.setVapidDetails(config.VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);
  return vapid;
}

export const whatsappConfigured = () => Boolean(config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_ACCESS_TOKEN);

export async function sendWhatsApp(to: string, title: string, body: string) {
  const number = to.replace(/[^\d]/g, '');
  const payload = config.WHATSAPP_TEMPLATE
    ? {
        messaging_product: 'whatsapp', to: number, type: 'template',
        template: { name: config.WHATSAPP_TEMPLATE, language: { code: config.WHATSAPP_TEMPLATE_LANG }, components: [{ type: 'body', parameters: [{ type: 'text', text: title.slice(0, 200) }, { type: 'text', text: (body || ' ').slice(0, 500) }] }] },
      }
    : { messaging_product: 'whatsapp', to: number, type: 'text', text: { body: `*${title}*${body ? `\n${body}` : ''}` } };
  const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(config.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export interface NotifyInput {
  type: string;
  title: string;
  body?: string;
  /** In-app path to open, e.g. "/calendar". */
  url?: string;
  data?: Record<string, unknown>;
  /** Also deliver via push/WhatsApp (default true). In-app is always created. */
  external?: boolean;
}

export interface NotifyTarget {
  /** Member IDs to notify. Default: every active member with a login. */
  to?: string[];
  /** Usually the actor who caused it; they don't need a notification. */
  except?: string | null;
  dedupeKey?: string;
}

/**
 * Creates in-app notifications and fans out to Web Push and WhatsApp per member preference.
 * Never throws: notification delivery must not break the request that triggered it.
 */
export async function notify(householdId: string, n: NotifyInput, target: NotifyTarget = {}) {
  try {
    const members = await prisma.householdMember.findMany({
      where: { householdId, isActive: true, userId: { not: null }, ...(target.to ? { id: { in: target.to } } : {}), ...(target.except ? { id: { not: target.except } } : {}) },
      select: { id: true, preferences: true },
    });
    const recipients = members.filter((m) => !notificationPrefs(m.preferences).muted?.includes(n.type));
    if (!recipients.length) return 0;
    const data = { ...(n.data ?? {}), url: n.url ?? '/' } as Prisma.InputJsonValue;
    const created = await prisma.notification.createMany({
      data: recipients.map((m) => ({ householdId, memberId: m.id, type: n.type, title: n.title, body: n.body ?? null, data, dedupeKey: target.dedupeKey ? `${target.dedupeKey}:${m.id}` : null })),
      skipDuplicates: true,
    });
    if (!created.count) return 0;
    realtime.publish(householdId, { type: 'notifications.changed', data: { title: n.title, body: n.body ?? '', notificationType: n.type, memberIds: recipients.map((m) => m.id) } });
    if (n.external !== false) void deliverExternal(householdId, recipients, n);
    return created.count;
  } catch (err) {
    logger.error({ err, type: n.type }, 'notify failed');
    return 0;
  }
}

async function deliverExternal(householdId: string, recipients: { id: string; preferences: Prisma.JsonValue }[], n: NotifyInput) {
  const pushIds = recipients.filter((m) => notificationPrefs(m.preferences).push).map((m) => m.id);
  if (pushIds.length) {
    try {
      await vapidKeys();
      const subs = await prisma.pushSubscription.findMany({ where: { householdId, memberId: { in: pushIds }, kind: 'WEB' } });
      const payload = JSON.stringify({ title: n.title, body: n.body ?? '', url: n.url ?? '/', tag: n.type });
      await Promise.all(
        subs.map(async (s) => {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys as { p256dh: string; auth: string } }, payload, { TTL: 3600, urgency: n.type === 'event.reminder' ? 'high' : 'normal' });
            await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } });
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
            else logger.warn({ err: e, code }, 'web push failed');
          }
        }),
      );
    } catch (err) {
      logger.error({ err }, 'web push delivery failed');
    }
    if (fcmConfigured()) {
      const tokens = await prisma.pushSubscription.findMany({ where: { householdId, memberId: { in: pushIds }, kind: 'FCM' } });
      for (const t of tokens) {
        try {
          const ok = await sendFcm(t.endpoint, { title: n.title, body: n.body ?? '', url: n.url ?? '/', tag: n.type });
          if (!ok) await prisma.pushSubscription.delete({ where: { id: t.id } }).catch(() => undefined);
        } catch (err) {
          logger.warn({ err }, 'fcm push failed');
        }
      }
    }
  }
  if (whatsappConfigured()) {
    for (const m of recipients) {
      const p = notificationPrefs(m.preferences);
      if (!p.whatsapp || !p.whatsappNumber) continue;
      await sendWhatsApp(p.whatsappNumber, n.title, n.body ?? '').catch((err) => logger.warn({ err }, 'whatsapp send failed'));
    }
  }
}
