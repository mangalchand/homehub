import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { can, createCalendarSchema, icsSubscribeSchema, updateCalendarSchema, CALENDAR_CATEGORIES, CALENDAR_VISIBILITIES } from '@familyhub/shared';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { encrypt } from '../lib/crypto.js';
import { badRequest, forbidden, unprocessable } from '../lib/errors.js';
import { normalizeFeedUrl } from '../lib/ssrf.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';
import { ctx, householdContext, requireCap } from '../auth/context.js';
import { parseIcs } from '../calendar/ics.js';
import { providerFor } from '../calendar/providers/index.js';
import { calendarDTO, canManageCalendar, loadCalendar, visibleCalendars } from '../calendar/service.js';
import { applyRemoteEvents, syncConnection } from '../calendar/sync.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const importBody = z.object({
  calendarId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  category: z.enum(CALENDAR_CATEGORIES).optional(),
  visibility: z.enum(CALENDAR_VISIBILITIES).optional(),
});

export function calendarsRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };

  async function reload(req: Parameters<typeof ctx>[0], id: string) {
    const c = ctx(req);
    const { cal, access } = await loadCalendar(c.householdId, c.actor, id);
    return calendarDTO(cal, access);
  }

  async function assertOwner(householdId: string, memberId: string | null | undefined) {
    if (!memberId) return;
    const exists = await prisma.householdMember.count({ where: { id: memberId, householdId } });
    if (!exists) throw badRequest('Calendar owner must be a household member');
  }

  route(m, { method: 'get', path: '/calendars', summary: 'List calendars visible to the caller', tags: ['Calendars'] }, async (req) => {
    const c = ctx(req);
    return (await visibleCalendars(c.householdId, c.actor)).map(({ cal, access }) => calendarDTO(cal, access));
  });

  route(
    m,
    { method: 'post', path: '/calendars', summary: 'Create a FamilyHub calendar', tags: ['Calendars'], body: createCalendarSchema, status: 201, middleware: [requireCap('events.write')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      if (c.actor.kind !== 'member') throw forbidden();
      const isManager = can(c.actor, 'calendars.manage');
      // Non-managers may only create personal calendars they own.
      const ownerMemberId = isManager ? (body.ownerMemberId ?? null) : c.actor.memberId;
      if (body.visibility === 'PRIVATE' && !ownerMemberId) throw badRequest('Private calendars need an owner');
      await assertOwner(c.householdId, ownerMemberId);
      const cal = await prisma.calendar.create({
        data: {
          householdId: c.householdId,
          name: body.name,
          description: body.description ?? null,
          color: body.color ?? '#6366f1',
          category: body.category,
          visibility: body.visibility,
          showOnWallDisplay: body.showOnWallDisplay,
          ownerMemberId,
          shares: body.shares?.length ? { create: body.shares.map((s) => ({ memberId: s.memberId, access: s.access })) } : undefined,
        },
      });
      await audit(req, { householdId: c.householdId, action: 'calendar.created', entityType: 'calendar', entityId: cal.id });
      realtime.publish(c.householdId, { type: 'calendars.changed' });
      return reload(req, cal.id);
    },
  );

  route(
    m,
    { method: 'patch', path: '/calendars/:calendarId', summary: 'Update calendar settings, privacy and sync mode', tags: ['Calendars'], body: updateCalendarSchema },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const { cal } = await loadCalendar(c.householdId, c.actor, req.params.calendarId!);
      if (!canManageCalendar(c.actor, cal, can(c.actor, 'calendars.manage'))) throw forbidden('Only the calendar owner or a household admin can change this calendar');
      if (body.ownerMemberId !== undefined) await assertOwner(c.householdId, body.ownerMemberId);
      if (body.syncMode === 'TWO_WAY') {
        const provider = providerFor(cal.source, cal.connection?.account?.externalAccountId);
        if (!cal.connection || !provider?.capabilities.twoWay) throw unprocessable('TWO_WAY_UNSUPPORTED', 'Two-way sync is not available for this calendar source');
        if (cal.isReadOnly) throw unprocessable('TWO_WAY_UNSUPPORTED', 'The provider reports this calendar as read-only');
      }
      const visibility = body.visibility ?? cal.visibility;
      const owner = body.ownerMemberId !== undefined ? body.ownerMemberId : cal.ownerMemberId;
      if (visibility === 'PRIVATE' && !owner) throw badRequest('Private calendars need an owner');
      await prisma.$transaction(async (tx) => {
        await tx.calendar.update({
          where: { id: cal.id },
          data: {
            name: body.name,
            description: body.description,
            color: body.color,
            category: body.category,
            visibility: body.visibility,
            showOnWallDisplay: body.showOnWallDisplay,
            ownerMemberId: body.ownerMemberId,
          },
        });
        if (body.shares) {
          await tx.calendarShare.deleteMany({ where: { calendarId: cal.id } });
          if (body.shares.length) await tx.calendarShare.createMany({ data: body.shares.map((s) => ({ calendarId: cal.id, memberId: s.memberId, access: s.access })) });
        }
        if (cal.connection && (body.syncMode || body.refreshIntervalMinutes)) {
          await tx.calendarConnection.update({
            where: { id: cal.connection.id },
            data: { syncMode: body.syncMode, refreshIntervalMinutes: body.refreshIntervalMinutes },
          });
        }
      });
      await audit(req, { householdId: c.householdId, action: 'calendar.updated', entityType: 'calendar', entityId: cal.id, metadata: { fields: Object.keys(body) } });
      realtime.publish(c.householdId, { type: 'calendars.changed' });
      return reload(req, cal.id);
    },
  );

  route(m, { method: 'delete', path: '/calendars/:calendarId', summary: 'Remove a calendar from FamilyHub (does not delete it at the provider)', tags: ['Calendars'] }, async (req) => {
    const c = ctx(req);
    const { cal } = await loadCalendar(c.householdId, c.actor, req.params.calendarId!);
    if (!canManageCalendar(c.actor, cal, can(c.actor, 'calendars.manage'))) throw forbidden();
    await prisma.calendar.delete({ where: { id: cal.id } });
    await audit(req, { householdId: c.householdId, action: 'calendar.deleted', entityType: 'calendar', entityId: cal.id, metadata: { name: cal.name, source: cal.source } });
    realtime.publish(c.householdId, { type: 'calendars.changed' });
    realtime.publish(c.householdId, { type: 'events.changed' });
    return undefined;
  });

  route(
    m,
    { method: 'post', path: '/calendars/subscribe', summary: 'Subscribe to an ICS/webcal feed (read-only)', tags: ['Calendars'], body: icsSubscribeSchema, status: 201, middleware: [requireCap('calendars.connect')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      if (c.actor.kind !== 'member') throw forbidden();
      let url: URL;
      try {
        url = normalizeFeedUrl(body.url);
      } catch (e) {
        throw badRequest((e as Error).message);
      }
      await assertOwner(c.householdId, body.ownerMemberId);
      const cal = await prisma.calendar.create({
        data: {
          householdId: c.householdId,
          name: body.name,
          color: body.color ?? '#64748b',
          category: body.category,
          source: 'ICS_URL',
          visibility: body.visibility,
          showOnWallDisplay: body.showOnWallDisplay,
          ownerMemberId: body.ownerMemberId ?? (body.visibility === 'PRIVATE' ? c.actor.memberId : null),
          isReadOnly: true,
          connection: {
            create: {
              encryptedSourceUrl: encrypt(url.toString()),
              refreshIntervalMinutes: body.refreshIntervalMinutes,
              syncState: { create: {} },
            },
          },
        },
        include: { connection: true },
      });
      const outcome = await syncConnection(cal.connection!.id, 'initial');
      if (!outcome.success) {
        await prisma.calendar.delete({ where: { id: cal.id } });
        throw unprocessable('SUBSCRIPTION_FAILED', `Could not load that calendar feed: ${outcome.error}`);
      }
      await audit(req, { householdId: c.householdId, action: 'calendar.subscribed', entityType: 'calendar', entityId: cal.id, metadata: { host: url.hostname } });
      realtime.publish(c.householdId, { type: 'calendars.changed' });
      return { calendar: await reload(req, cal.id), sync: outcome };
    },
  );

  route(
    m,
    {
      method: 'post', path: '/calendars/import', summary: 'Import a .ics file (multipart field "file") into a new or existing calendar', tags: ['Calendars'],
      body: importBody, status: 201, middleware: [requireCap('events.write'), upload.single('file')],
    },
    async (req, _res, { body }) => {
      const c = ctx(req);
      if (c.actor.kind !== 'member') throw forbidden();
      const file = req.file;
      if (!file) throw badRequest('Attach an .ics file in the "file" field');
      if (!/\.ics$/i.test(file.originalname) && !/calendar/.test(file.mimetype)) throw badRequest('Only .ics files are supported');
      const events = parseIcs(file.buffer.toString('utf8'), c.household.timezone);
      let calendarId = body.calendarId;
      if (calendarId) {
        const { cal, access } = await loadCalendar(c.householdId, c.actor, calendarId);
        if (access !== 'WRITE' || cal.source !== 'INTERNAL') throw forbidden('Choose a FamilyHub calendar you can edit');
      } else {
        const cal = await prisma.calendar.create({
          data: {
            householdId: c.householdId,
            name: body.name ?? file.originalname.replace(/\.ics$/i, '').slice(0, 80),
            category: body.category ?? 'OTHER',
            visibility: body.visibility ?? 'HOUSEHOLD',
            source: 'ICS_FILE',
            isReadOnly: true,
            ownerMemberId: body.visibility === 'PRIVATE' ? c.actor.memberId : null,
            color: '#8b5cf6',
          },
        });
        calendarId = cal.id;
      }
      const counts = await applyRemoteEvents({ id: calendarId, householdId: c.householdId }, { events, deletedExternalIds: [], fullSync: false });
      await audit(req, { householdId: c.householdId, action: 'calendar.imported', entityType: 'calendar', entityId: calendarId, metadata: { ...counts } });
      realtime.publish(c.householdId, { type: 'calendars.changed' });
      realtime.publish(c.householdId, { type: 'events.changed' });
      return { calendar: await reload(req, calendarId), ...counts, parsed: events.length };
    },
  );

  route(m, { method: 'post', path: '/calendars/:calendarId/sync', summary: 'Sync an external calendar now', tags: ['Calendars'] }, async (req) => {
    const c = ctx(req);
    const { cal } = await loadCalendar(c.householdId, c.actor, req.params.calendarId!);
    if (!cal.connection) throw unprocessable('NOT_SYNCED', 'This calendar is not connected to an external source');
    if (!canManageCalendar(c.actor, cal, can(c.actor, 'calendars.manage'))) throw forbidden();
    const outcome = await syncConnection(cal.connection.id, 'manual');
    return { calendar: await reload(req, cal.id), sync: outcome };
  });

  route(m, { method: 'get', path: '/calendars/:calendarId/sync-runs', summary: 'Recent sync history', tags: ['Calendars'] }, async (req) => {
    const c = ctx(req);
    const { cal } = await loadCalendar(c.householdId, c.actor, req.params.calendarId!);
    if (!cal.connection) return [];
    return prisma.calendarSyncRun.findMany({ where: { connectionId: cal.connection.id }, orderBy: { startedAt: 'desc' }, take: 20 });
  });

  return router;
}
