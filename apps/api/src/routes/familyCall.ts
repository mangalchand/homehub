import { Router } from 'express';
import { z } from 'zod';
import { whatsappCallUrlSchema } from '@familyhub/shared';
import { ctx, householdContext, requireCap } from '../auth/context.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { realtime } from '../lib/realtime.js';
import { notify } from '../lib/notify.js';
import { badRequest } from '../lib/errors.js';
import { route, type Mount } from '../lib/route.js';

const saveFamilyCallSchema = z.object({ whatsappCallUrl: whatsappCallUrlSchema.nullable() }).strict();
const callSelection = { whatsappCallUrl: true, callGroups: true } as const;
const callGroupSchema = z
  .object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().trim().min(1).max(40), url: whatsappCallUrlSchema })
  .strict();
const saveGroupsSchema = z
  .object({ groups: z.array(callGroupSchema).max(10).refine((g) => new Set(g.map((x) => x.id)).size === g.length, 'Each group needs a unique id.') })
  .strict();
const readGroups = (raw: unknown) => z.array(callGroupSchema).catch([]).parse(raw ?? []);
const callView = (s: { whatsappCallUrl: string | null; callGroups: unknown } | null) => ({
  whatsappCallUrl: s?.whatsappCallUrl ?? null,
  groups: readGroups(s?.callGroups),
});

export function familyCallRouter() {
  const router = Router({ mergeParams: true });
  router.use('/family-call', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };

  route(
    m,
    {
      method: 'get',
      path: '/family-call',
      summary: 'Read the household WhatsApp call link',
      tags: ['Family call'],
    },
    async (req) => {
      const settings = await prisma.householdFeatureSettings.findUnique({
        where: { householdId: ctx(req).householdId },
        select: callSelection,
      });
      return callView(settings);
    },
  );

  route(
    m,
    {
      method: 'post',
      path: '/family-call/notify',
      summary: 'Notify household members about the saved WhatsApp call link',
      tags: ['Family call'],
      body: z.object({ groupId: z.string().max(40).optional() }).strict(),
      status: 202,
      middleware: [requireCap('dashboard.manage')],
    },
    async (req, _res, { body }) => {
      const { householdId } = ctx(req);
      const settings = await prisma.householdFeatureSettings.findUnique({
        where: { householdId },
        select: callSelection,
      });
      const group = body.groupId ? readGroups(settings?.callGroups).find((g) => g.id === body.groupId) : null;
      if (body.groupId && !group) throw badRequest('That call group no longer exists.');
      const link = group?.url ?? settings?.whatsappCallUrl;
      if (!link) throw badRequest('Save a WhatsApp call link before notifying the household.');
      const label = group ? `${group.name} call` : 'family WhatsApp call';
      const minute = Math.floor(Date.now() / 60_000);
      await notify(
        householdId,
        {
          type: 'family-call.invitation',
          title: `Join the ${label}`,
          body: `A call is ready. Tap to open WhatsApp and join: ${link}`,
          url: link,
          householdFeed: true,
        },
        { dedupeKey: `family-call-invitation:${householdId}:${group?.id ?? 'family'}:${minute}` },
      );
      await audit(req, {
        householdId,
        action: 'family-call.invited',
        entityType: 'household',
        entityId: householdId,
      });
      return { sent: true, reminder: 'Each person must open the link and tap Join in WhatsApp.' };
    },
  );

  route(
    m,
    {
      method: 'patch',
      path: '/family-call',
      summary: 'Set or clear the household WhatsApp call link',
      tags: ['Family call'],
      body: saveFamilyCallSchema,
      middleware: [requireCap('dashboard.manage')],
    },
    async (req, _res, { body }) => {
      const { householdId } = ctx(req);
      const settings = await prisma.householdFeatureSettings.upsert({
        where: { householdId },
        create: { householdId, ...body },
        update: body,
        select: callSelection,
      });
      await audit(req, {
        householdId,
        action: body.whatsappCallUrl === null ? 'family-call.cleared' : 'family-call.updated',
        entityType: 'household',
        entityId: householdId,
      });
      realtime.publish(householdId, { type: 'family-call.changed' });
      return callView(settings);
    },
  );

  route(
    m,
    {
      method: 'put',
      path: '/family-call/groups',
      summary: 'Replace the named call groups (e.g. Family, Friends)',
      tags: ['Family call'],
      body: saveGroupsSchema,
      middleware: [requireCap('dashboard.manage')],
    },
    async (req, _res, { body }) => {
      const { householdId } = ctx(req);
      const settings = await prisma.householdFeatureSettings.upsert({
        where: { householdId },
        create: { householdId, callGroups: body.groups },
        update: { callGroups: body.groups },
        select: callSelection,
      });
      await audit(req, { householdId, action: 'family-call.groups-updated', entityType: 'household', entityId: householdId });
      realtime.publish(householdId, { type: 'family-call.changed' });
      return callView(settings);
    },
  );

  return router;
}
