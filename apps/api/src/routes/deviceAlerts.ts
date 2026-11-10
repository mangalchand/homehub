import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ctx, householdContext } from '../auth/context.js';
import { notify } from '../lib/notify.js';
import { route, type Mount } from '../lib/route.js';

export const HOME_ALERT_SOURCES = {
  ring: 'Ring',
  blink: 'Blink',
  myq: 'myQ',
  eufy: 'Eufy',
  'google-home': 'Google Home',
  nest: 'Nest',
  arlo: 'Arlo',
  simplisafe: 'SimpliSafe',
  wyze: 'Wyze',
} as const;
const sources = Object.keys(HOME_ALERT_SOURCES) as [keyof typeof HOME_ALERT_SOURCES, ...(keyof typeof HOME_ALERT_SOURCES)[]];
const clean = (s: string) => Array.from(s, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').trim();
const alertSchema = z
  .object({
    source: z.enum(sources),
    title: z.string().max(120).transform(clean),
    text: z.string().max(300).transform(clean).default(''),
  })
  .strict()
  .refine((a) => a.title || a.text, 'Alert needs a title or text.');

/** Alerts mirrored from home-security apps on an Android display (Notification access). */
export function deviceAlertsRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };
  route(
    m,
    { method: 'post', path: '/device-alerts', summary: 'Mirror a Ring/Blink/myQ app alert to the household', tags: ['Home alerts'], body: alertSchema, status: 202 },
    async (req, _res, { body }) => {
      const c = ctx(req);
      if (c.actor.kind === 'member' && (c.actor.role === 'GUEST' || c.actor.role === 'CHILD')) return { accepted: false };
      const label = HOME_ALERT_SOURCES[body.source];
      const digest = createHash('sha256').update(`${body.source}|${body.title}|${body.text}`).digest('hex').slice(0, 24);
      const minute = Math.floor(Date.now() / 60_000);
      const created = await notify(
        c.householdId,
        { type: 'device.alert', title: `${label}: ${body.title || body.text}`.slice(0, 160), body: body.title ? body.text || undefined : undefined, url: '/home-management', householdFeed: true, external: false },
        { dedupeKey: `device-alert:${c.householdId}:${digest}:${minute}` },
      );
      return { accepted: created > 0 };
    },
  );
  return router;
}
