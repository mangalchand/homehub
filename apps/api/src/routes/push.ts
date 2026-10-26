import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AppError } from '../lib/errors.js';
import { notificationPrefs, notify, sendWhatsApp, vapidKeys, whatsappConfigured } from '../lib/notify.js';
import { route, type Mount } from '../lib/route.js';
import { ctx, householdContext } from '../auth/context.js';

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
const prefsSchema = z.object({
  push: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
  whatsappNumber: z.string().trim().regex(/^\+?[1-9]\d{6,14}$/, 'Use international format, e.g. +14155550123').or(z.literal('')).optional(),
  muted: z.array(z.string().max(60)).max(50).optional(),
});

function memberOf(req: Parameters<typeof ctx>[0]) {
  const c = ctx(req);
  if (c.actor.kind !== 'member') throw new AppError(403, 'MEMBER_ONLY', 'Notifications are set up per family member, not on shared displays');
  return { c, memberId: c.actor.memberId };
}

export function pushRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };

  route(m, { method: 'get', path: '/notifications/settings', summary: 'My notification channels and Web Push key', tags: ['Notifications'] }, async (req) => {
    const c0 = ctx(req);
    if (c0.actor.kind === 'device') {
      const pushDevices = await prisma.pushSubscription.count({ where: { householdId: c0.householdId, deviceId: c0.actor.deviceId } });
      return { ...notificationPrefs({}), pushDevices, vapidPublicKey: '', whatsappAvailable: false };
    }
    const { c, memberId } = memberOf(req);
    const member = await prisma.householdMember.findUniqueOrThrow({ where: { id: memberId }, select: { preferences: true } });
    const devices = await prisma.pushSubscription.count({ where: { householdId: c.householdId, memberId } });
    return { ...notificationPrefs(member.preferences), pushDevices: devices, vapidPublicKey: (await vapidKeys()).publicKey, whatsappAvailable: whatsappConfigured() };
  });

  route(m, { method: 'patch', path: '/notifications/settings', summary: 'Update my notification channels', tags: ['Notifications'], body: prefsSchema }, async (req, _res, { body }) => {
    const { memberId } = memberOf(req);
    const member = await prisma.householdMember.findUniqueOrThrow({ where: { id: memberId }, select: { preferences: true } });
    const prefs = (member.preferences ?? {}) as Record<string, unknown>;
    const next = { ...notificationPrefs(prefs), ...body };
    if (next.whatsapp && !next.whatsappNumber) throw new AppError(422, 'WHATSAPP_NUMBER_REQUIRED', 'Add your WhatsApp number first');
    await prisma.householdMember.update({ where: { id: memberId }, data: { preferences: { ...prefs, notifications: next } } });
    return next;
  });

  route(m, { method: 'post', path: '/push/subscribe', summary: 'Register this browser for Web Push', tags: ['Notifications'], body: subscribeSchema, status: 201 }, async (req, _res, { body }) => {
    const { c, memberId } = memberOf(req);
    await prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: { householdId: c.householdId, memberId, endpoint: body.endpoint, keys: body.keys, userAgent: req.get('user-agent')?.slice(0, 300) ?? null },
      update: { householdId: c.householdId, memberId, keys: body.keys },
    });
    return { ok: true };
  });

  route(m, { method: 'post', path: '/push/fcm-token', summary: 'Register the Android app (FCM) for push', tags: ['Notifications'], body: z.object({ token: z.string().min(20).max(4096) }), status: 201 }, async (req, _res, { body }) => {
    const dc = ctx(req);
    if (dc.actor.kind === 'device') {
      const deviceId = dc.actor.deviceId;
      await prisma.pushSubscription.upsert({
        where: { endpoint: body.token },
        create: { householdId: dc.householdId, deviceId, kind: 'FCM', endpoint: body.token, userAgent: req.get('user-agent')?.slice(0, 300) ?? null },
        update: { householdId: dc.householdId, deviceId, memberId: null, kind: 'FCM' },
      });
      return { ok: true };
    }
    const { c, memberId } = memberOf(req);
    await prisma.pushSubscription.upsert({
      where: { endpoint: body.token },
      create: { householdId: c.householdId, memberId, kind: 'FCM', endpoint: body.token, userAgent: req.get('user-agent')?.slice(0, 300) ?? null },
      update: { householdId: c.householdId, memberId, deviceId: null, kind: 'FCM' },
    });
    return { ok: true };
  });

  route(m, { method: 'post', path: '/push/unsubscribe', summary: 'Stop Web Push on this browser', tags: ['Notifications'], body: z.object({ endpoint: z.string().url().max(2000) }) }, async (req, _res, { body }) => {
    const { memberId } = memberOf(req);
    await prisma.pushSubscription.deleteMany({ where: { endpoint: body.endpoint, memberId } });
    return { ok: true };
  });

  route(m, { method: 'post', path: '/notifications/test', summary: 'Send myself a test notification on every channel', tags: ['Notifications'] }, async (req) => {
    const dc = ctx(req);
    if (dc.actor.kind === 'device') {
      const n = await notify(dc.householdId, { type: 'test', title: 'FamilyHub tablet test', body: 'Tablet alerts and push are connected. Check the chime volume and Android notification permission.', householdFeed: true }, { to: [] });
      return { inApp: n > 0, whatsapp: 'off' };
    }
    const { c, memberId } = memberOf(req);
    const n = await notify(c.householdId, { type: 'test', title: 'FamilyHub test notification', body: 'Notifications are working on this device.', url: '/' }, { to: [memberId] });
    const member = await prisma.householdMember.findUniqueOrThrow({ where: { id: memberId }, select: { preferences: true } });
    const p = notificationPrefs(member.preferences);
    let whatsapp: string = 'off';
    if (p.whatsapp && p.whatsappNumber) {
      if (!whatsappConfigured()) whatsapp = 'not configured on server';
      else {
        try {
          await sendWhatsApp(p.whatsappNumber, 'FamilyHub test notification', 'WhatsApp notifications are working.');
          whatsapp = 'sent';
        } catch (e) {
          whatsapp = (e as Error).message;
        }
      }
    }
    return { inApp: n > 0, whatsapp };
  });

  return router;
}
