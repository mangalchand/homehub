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
const callSelection = { whatsappCallUrl: true } as const;

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
      return { whatsappCallUrl: settings?.whatsappCallUrl ?? null };
    },
  );

  route(
    m,
    {
      method: 'post',
      path: '/family-call/notify',
      summary: 'Notify household members about the saved WhatsApp call link',
      tags: ['Family call'],
      body: z.object({}).strict(),
      status: 202,
      middleware: [requireCap('dashboard.manage')],
    },
    async (req) => {
      const { householdId } = ctx(req);
      const settings = await prisma.householdFeatureSettings.findUnique({
        where: { householdId },
        select: callSelection,
      });
      if (!settings?.whatsappCallUrl)
        throw badRequest('Save a WhatsApp call link before notifying the household.');
      const minute = Math.floor(Date.now() / 60_000);
      await notify(
        householdId,
        {
          type: 'family-call.invitation',
          title: 'Join the family WhatsApp call',
          body: `A family call is ready. Tap to open WhatsApp and join: ${settings.whatsappCallUrl}`,
          url: settings.whatsappCallUrl,
          householdFeed: true,
        },
        { dedupeKey: `family-call-invitation:${householdId}:${minute}` },
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
      return settings;
    },
  );

  return router;
}
