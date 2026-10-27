import { Router } from 'express';
import { z } from 'zod';
import { can, updateHouseholdFeatureSettingsSchema, type HouseholdFeatureSettingsDTO } from '@familyhub/shared';
import { prisma } from '../db.js';
import { ctx, householdContext, requireCap } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { route, type Mount } from '../lib/route.js';
import { realtime } from '../lib/realtime.js';
import { buildEveningSummary, summaryRunDTO, summarySchedule, SUMMARY_DELIVERY_NOTE } from '../jobs/eveningSummary.js';

const patchSchema = updateHouseholdFeatureSettingsSchema.pick({ dailySummaryEnabled: true, dailySummaryTime: true }).strict();

async function readSettings(householdId: string): Promise<HouseholdFeatureSettingsDTO> {
  const settings = await prisma.householdFeatureSettings.upsert({ where: { householdId }, create: { householdId }, update: {} });
  return { householdId, dailySummaryEnabled: settings.dailySummaryEnabled, dailySummaryTime: settings.dailySummaryTime, whatsappCallUrl: settings.whatsappCallUrl, createdAt: settings.createdAt.toISOString(), updatedAt: settings.updatedAt.toISOString() };
}

/** Mount at /api/v1/households/:householdId after authenticate and csrfProtection. */
export function summariesRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };

  route(m, { method: 'get', path: '/summaries/settings', summary: 'Read daily summary schedule and delivery policy', tags: ['Summaries'] }, async (req) => {
    const c = ctx(req);
    return { ...await readSettings(c.householdId), timezone: c.household.timezone, canManage: can(c.actor, 'dashboard.manage'), deliveryNote: SUMMARY_DELIVERY_NOTE };
  });

  route(m, {
    method: 'patch', path: '/summaries/settings', summary: 'Change daily summary schedule (owner/admin or PIN-unlocked display)', tags: ['Summaries'],
    body: patchSchema, middleware: [requireCap('dashboard.manage')],
  }, async (req, _res, { body }) => {
    const c = ctx(req);
    await prisma.householdFeatureSettings.upsert({ where: { householdId: c.householdId }, create: { householdId: c.householdId, ...body }, update: body });
    await audit(req, { householdId: c.householdId, action: 'summary.settings_updated', entityType: 'household', entityId: c.householdId, metadata: body });
    realtime.publish(c.householdId, { type: 'summaries.changed' });
    return { ...await readSettings(c.householdId), timezone: c.household.timezone, canManage: true, deliveryNote: SUMMARY_DELIVERY_NOTE };
  });

  route(m, { method: 'get', path: '/summaries/preview', summary: 'Preview the current household task and points summary (does not send)', tags: ['Summaries'] }, async (req) => {
    const c = ctx(req);
    const now = new Date();
    return { localDate: summarySchedule(now, c.household.timezone).localDate, timezone: c.household.timezone, payload: await buildEveningSummary(c.household, now) };
  });

  route(m, {
    method: 'get', path: '/summaries', summary: 'Saved daily summary history (newest first)', tags: ['Summaries'],
    query: z.object({ before: z.string().date().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  }, async (req, _res, { query }) => {
    const c = ctx(req);
    const runs = await prisma.dailySummaryRun.findMany({
      where: { householdId: c.householdId, ...(query.before ? { localDate: { lt: new Date(`${query.before}T00:00:00.000Z`) } } : {}) },
      orderBy: { localDate: 'desc' }, take: query.limit + 1,
    });
    const page = runs.slice(0, query.limit).map(summaryRunDTO);
    return { runs: page, nextBefore: runs.length > query.limit ? page[page.length - 1]!.localDate : null, deliveryNote: SUMMARY_DELIVERY_NOTE };
  });
  return router;
}
