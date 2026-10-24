import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { createEventSchema, deleteEventSchema, eventRangeQuery, updateEventSchema } from '@familyhub/shared';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { logger } from '../logger.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';
import { ctx, householdContext, requireCap } from '../auth/context.js';
import { calendarAccess, eventView, type CalendarWithAccess } from '../calendar/access.js';
import { isOccurrenceOf, stripRrulePrefix, truncateRule } from '../calendar/recurrence.js';
import { listOccurrences, loadCalendar, loadCalendarForWrite, type LoadedCalendar } from '../calendar/service.js';
import { pushEventChange } from '../calendar/sync.js';

type EventWithAssignments = Prisma.CalendarEventGetPayload<{ include: { assignments: true } }>;

const isTwoWay = (cal: LoadedCalendar) => (cal.source === 'GOOGLE' || cal.source === 'MICROSOFT') && cal.connection?.syncMode === 'TWO_WAY';

function schedulePush(eventId: string) {
  setImmediate(() => {
    pushEventChange(eventId).catch((err) => logger.error({ err, eventId }, 'event push failed'));
  });
}

function eventDetail(ev: EventWithAssignments, busyOnly = false, canEdit = true) {
  return {
    id: ev.id,
    calendarId: ev.calendarId,
    title: busyOnly ? 'Busy' : ev.title,
    description: busyOnly ? null : ev.description,
    location: busyOnly ? null : ev.location,
    startAt: ev.startAt.toISOString(),
    endAt: ev.endAt.toISOString(),
    allDay: ev.allDay,
    timezone: ev.timezone,
    rrule: busyOnly ? null : ev.rrule,
    exdates: busyOnly ? [] : ev.exdates.map((d) => d.toISOString()),
    recurringEventId: ev.recurringEventId,
    originalStartAt: ev.originalStartAt?.toISOString() ?? null,
    isPrivate: ev.isPrivate,
    busyOnly,
    category: busyOnly ? null : ev.category,
    color: ev.color,
    reminderMinutes: ev.reminderMinutes,
    memberIds: ev.assignments.map((a) => a.memberId),
    syncState: ev.syncState,
    syncError: busyOnly ? null : ev.syncError,
    version: ev.version,
    canEdit,
    updatedAt: ev.updatedAt.toISOString(),
  };
}

async function assertMembers(householdId: string, memberIds: string[] | undefined) {
  if (!memberIds?.length) return;
  const n = await prisma.householdMember.count({ where: { householdId, id: { in: memberIds } } });
  if (n !== new Set(memberIds).size) throw badRequest('One or more assigned members do not belong to this household');
}

export function eventsRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };

  async function loadEventForWrite(req: Parameters<typeof ctx>[0], eventId: string) {
    const c = ctx(req);
    const ev = await prisma.calendarEvent.findFirst({
      where: { id: eventId, householdId: c.householdId, deletedAt: null },
      include: { assignments: true },
    });
    if (!ev) throw notFound('Event');
    const { cal, access } = await loadCalendar(c.householdId, c.actor, ev.calendarId).catch(() => {
      throw notFound('Event');
    });
    const view = eventView(c.actor, cal as CalendarWithAccess, access, ev);
    if (!view.visible) throw notFound('Event');
    if (!view.canEdit) {
      await loadCalendarForWrite(c.householdId, c.actor, ev.calendarId);
      throw unprocessable('EVENT_READ_ONLY', 'You cannot edit this event');
    }
    return { ev, cal };
  }

  function afterChange(req: Parameters<typeof ctx>[0], action: string, ev: { id: string; calendarId: string }, cal: LoadedCalendar, pending: boolean) {
    const c = ctx(req);
    void audit(req, { householdId: c.householdId, action, entityType: 'event', entityId: ev.id, metadata: { calendarId: ev.calendarId } });
    realtime.publish(c.householdId, { type: 'events.changed', entityId: ev.calendarId });
    if (pending && isTwoWay(cal)) schedulePush(ev.id);
  }

  route(
    m,
    { method: 'get', path: '/events', summary: 'List event occurrences in a date range (privacy-filtered)', tags: ['Events'], query: eventRangeQuery },
    async (req, _res, { query }) => {
      const c = ctx(req);
      return listOccurrences(c.householdId, c.actor, {
        start: new Date(query.start),
        end: new Date(query.end),
        calendarIds: query.calendarIds?.split(',').filter(Boolean),
        memberIds: query.memberIds?.split(',').filter(Boolean),
        q: query.q,
      });
    },
  );

  route(m, { method: 'get', path: '/events/:eventId', summary: 'Get an event', tags: ['Events'] }, async (req) => {
    const c = ctx(req);
    const ev = await prisma.calendarEvent.findFirst({
      where: { id: req.params.eventId, householdId: c.householdId, deletedAt: null },
      include: { assignments: true },
    });
    if (!ev) throw notFound('Event');
    const cal = await prisma.calendar.findFirst({ where: { id: ev.calendarId }, include: { shares: true, connection: true } });
    if (!cal) throw notFound('Event');
    const access = calendarAccess(c.actor, cal);
    const view = eventView(c.actor, cal, access, ev);
    if (!view.visible) throw notFound('Event');
    return eventDetail(ev, view.busyOnly, view.canEdit);
  });

  route(
    m,
    { method: 'post', path: '/events', summary: 'Create an event', tags: ['Events'], body: createEventSchema, status: 201, middleware: [requireCap('events.write')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const { cal } = await loadCalendarForWrite(c.householdId, c.actor, body.calendarId);
      await assertMembers(c.householdId, body.memberIds);
      const twoWay = isTwoWay(cal);
      const ev = await prisma.calendarEvent.create({
        data: {
          householdId: c.householdId,
          calendarId: cal.id,
          title: body.title,
          description: body.description ?? null,
          location: body.location ?? null,
          startAt: new Date(body.startAt),
          endAt: new Date(body.endAt),
          allDay: body.allDay,
          timezone: body.allDay ? 'UTC' : (body.timezone ?? cal.timezone ?? c.household.timezone),
          rrule: body.rrule ? stripRrulePrefix(body.rrule) : null,
          isPrivate: body.isPrivate,
          category: body.category ?? null,
          color: body.color ?? null,
          reminderMinutes: body.reminderMinutes,
          syncState: twoWay ? 'PENDING_CREATE' : 'LOCAL_ONLY',
          createdById: c.actor.kind === 'member' ? c.actor.userId : null,
          assignments: { create: body.memberIds.map((memberId) => ({ memberId })) },
        },
        include: { assignments: true },
      });
      afterChange(req, 'event.created', ev, cal, twoWay);
      return eventDetail(ev);
    },
  );

  route(
    m,
    { method: 'patch', path: '/events/:eventId', summary: 'Update an event (scope: this | following | all)', tags: ['Events'], body: updateEventSchema, middleware: [requireCap('events.write')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const { ev, cal } = await loadEventForWrite(req, req.params.eventId!);
      if (body.calendarId && body.calendarId !== ev.calendarId) {
        if (cal.source !== 'INTERNAL') throw unprocessable('MOVE_UNSUPPORTED', 'Events cannot be moved out of a synced calendar');
        const target = await loadCalendarForWrite(c.householdId, c.actor, body.calendarId);
        if (target.cal.source !== 'INTERNAL') throw unprocessable('MOVE_UNSUPPORTED', 'Events can only be moved between FamilyHub calendars');
      }
      if (body.expectedVersion !== undefined && body.expectedVersion !== ev.version) {
        throw conflict('This event was changed by someone else. Reload and try again.', { currentVersion: ev.version });
      }
      await assertMembers(c.householdId, body.memberIds);
      const twoWay = isTwoWay(cal);
      const scope = ev.rrule && !ev.recurringEventId ? body.scope : 'all';
      const occurrenceStart = body.occurrenceStart ? new Date(body.occurrenceStart) : null;
      if (scope !== 'all') {
        if (cal.source !== 'INTERNAL') {
          throw unprocessable('UNSUPPORTED_FOR_SYNCED', 'Editing single occurrences of synced recurring events is not supported yet. Edit the whole series or use the provider app.');
        }
        if (!occurrenceStart || !isOccurrenceOf(ev, occurrenceStart)) throw badRequest('occurrenceStart must be an occurrence of this series');
      }

      const fields = {
        title: body.title,
        description: body.description,
        location: body.location,
        allDay: body.allDay,
        timezone: body.timezone,
        isPrivate: body.isPrivate,
        category: body.category,
        color: body.color,
        reminderMinutes: body.reminderMinutes,
      };
      const memberIds = body.memberIds ?? ev.assignments.map((a) => a.memberId);
      const duration = ev.endAt.getTime() - ev.startAt.getTime();

      if (scope === 'this') {
        const start = body.startAt ? new Date(body.startAt) : occurrenceStart!;
        const end = body.endAt ? new Date(body.endAt) : new Date(start.getTime() + duration);
        const existing = await prisma.calendarEvent.findFirst({ where: { recurringEventId: ev.id, originalStartAt: occurrenceStart! } });
        const data = {
          title: fields.title ?? ev.title,
          description: fields.description !== undefined ? fields.description : ev.description,
          location: fields.location !== undefined ? fields.location : ev.location,
          allDay: fields.allDay ?? ev.allDay,
          timezone: fields.timezone ?? ev.timezone,
          isPrivate: fields.isPrivate ?? ev.isPrivate,
          category: fields.category !== undefined ? fields.category : ev.category,
          color: fields.color !== undefined ? fields.color : ev.color,
          reminderMinutes: fields.reminderMinutes ?? ev.reminderMinutes,
          startAt: start,
          endAt: end,
          status: 'CONFIRMED' as const,
          deletedAt: null,
        };
        const override = existing
          ? await prisma.calendarEvent.update({
              where: { id: existing.id },
              data: { ...data, version: { increment: 1 }, assignments: { deleteMany: {}, create: memberIds.map((memberId) => ({ memberId })) } },
              include: { assignments: true },
            })
          : await prisma.calendarEvent.create({
              data: {
                ...data,
                householdId: c.householdId,
                calendarId: ev.calendarId,
                recurringEventId: ev.id,
                originalStartAt: occurrenceStart!,
                createdById: ev.createdById,
                assignments: { create: memberIds.map((memberId) => ({ memberId })) },
              },
              include: { assignments: true },
            });
        afterChange(req, 'event.occurrence_updated', override, cal, false);
        return eventDetail(override);
      }

      if (scope === 'following' && occurrenceStart!.getTime() !== ev.startAt.getTime()) {
        const start = body.startAt ? new Date(body.startAt) : occurrenceStart!;
        const end = body.endAt ? new Date(body.endAt) : new Date(start.getTime() + duration);
        const baseRule = stripRrulePrefix(ev.rrule!).split(';').filter((p) => !/^COUNT=/i.test(p)).join(';');
        const newRule = body.rrule !== undefined ? (body.rrule ? stripRrulePrefix(body.rrule) : null) : baseRule;
        const created = await prisma.$transaction(async (tx) => {
          await tx.calendarEvent.update({
            where: { id: ev.id },
            data: { rrule: truncateRule(ev.rrule!, occurrenceStart!), exdates: ev.exdates.filter((d) => d < occurrenceStart!), version: { increment: 1 } },
          });
          await tx.calendarEvent.deleteMany({ where: { recurringEventId: ev.id, originalStartAt: { gte: occurrenceStart! } } });
          return tx.calendarEvent.create({
            data: {
              householdId: c.householdId,
              calendarId: body.calendarId ?? ev.calendarId,
              title: fields.title ?? ev.title,
              description: fields.description !== undefined ? fields.description : ev.description,
              location: fields.location !== undefined ? fields.location : ev.location,
              allDay: fields.allDay ?? ev.allDay,
              timezone: fields.timezone ?? ev.timezone,
              isPrivate: fields.isPrivate ?? ev.isPrivate,
              category: fields.category !== undefined ? fields.category : ev.category,
              color: fields.color !== undefined ? fields.color : ev.color,
              reminderMinutes: fields.reminderMinutes ?? ev.reminderMinutes,
              startAt: start,
              endAt: end,
              rrule: newRule,
              exdates: ev.exdates.filter((d) => d >= occurrenceStart!),
              createdById: ev.createdById,
              assignments: { create: memberIds.map((memberId) => ({ memberId })) },
            },
            include: { assignments: true },
          });
        });
        afterChange(req, 'event.series_split', created, cal, false);
        return eventDetail(created);
      }

      // Whole event / whole series.
      const updated = await prisma.calendarEvent.update({
        where: { id: ev.id },
        data: {
          ...fields,
          calendarId: body.calendarId,
          startAt: body.startAt ? new Date(body.startAt) : undefined,
          endAt: body.endAt ? new Date(body.endAt) : undefined,
          rrule: body.rrule === undefined ? undefined : body.rrule ? stripRrulePrefix(body.rrule) : null,
          version: { increment: 1 },
          syncState: twoWay ? (ev.syncState === 'PENDING_CREATE' || !ev.externalId ? 'PENDING_CREATE' : 'PENDING_UPDATE') : undefined,
          syncError: twoWay ? null : undefined,
          ...(body.memberIds ? { assignments: { deleteMany: {}, create: body.memberIds.map((memberId) => ({ memberId })) } } : {}),
        },
        include: { assignments: true },
      });
      if (updated.endAt < updated.startAt) throw badRequest('endAt must be after startAt');
      afterChange(req, 'event.updated', updated, cal, twoWay);
      return eventDetail(updated);
    },
  );

  route(
    m,
    { method: 'delete', path: '/events/:eventId', summary: 'Delete an event (scope: this | following | all)', tags: ['Events'], query: deleteEventSchema, middleware: [requireCap('events.write')] },
    async (req, _res, { query }) => {
      const { ev, cal } = await loadEventForWrite(req, req.params.eventId!);
      const twoWay = isTwoWay(cal);
      const scope = ev.rrule && !ev.recurringEventId ? query.scope : 'all';
      const occurrenceStart = query.occurrenceStart ? new Date(query.occurrenceStart) : null;
      if (scope !== 'all') {
        if (cal.source !== 'INTERNAL') {
          throw unprocessable('UNSUPPORTED_FOR_SYNCED', 'Deleting single occurrences of synced recurring events is not supported yet.');
        }
        if (!occurrenceStart || !isOccurrenceOf(ev, occurrenceStart)) throw badRequest('occurrenceStart must be an occurrence of this series');
      }
      if (scope === 'this') {
        await prisma.$transaction([
          prisma.calendarEvent.update({ where: { id: ev.id }, data: { exdates: { push: occurrenceStart! }, version: { increment: 1 } } }),
          prisma.calendarEvent.deleteMany({ where: { recurringEventId: ev.id, originalStartAt: occurrenceStart! } }),
        ]);
        afterChange(req, 'event.occurrence_deleted', ev, cal, false);
        return undefined;
      }
      if (scope === 'following' && occurrenceStart!.getTime() !== ev.startAt.getTime()) {
        await prisma.$transaction([
          prisma.calendarEvent.update({ where: { id: ev.id }, data: { rrule: truncateRule(ev.rrule!, occurrenceStart!), version: { increment: 1 } } }),
          prisma.calendarEvent.deleteMany({ where: { recurringEventId: ev.id, originalStartAt: { gte: occurrenceStart! } } }),
        ]);
        afterChange(req, 'event.series_truncated', ev, cal, false);
        return undefined;
      }
      const pendingDelete = twoWay && Boolean(ev.externalId);
      await prisma.calendarEvent.update({
        where: { id: ev.id },
        data: { deletedAt: new Date(), syncState: pendingDelete ? 'PENDING_DELETE' : ev.syncState, version: { increment: 1 } },
      });
      afterChange(req, 'event.deleted', ev, cal, pendingDelete);
      return undefined;
    },
  );

  route(m, { method: 'post', path: '/events/:eventId/retry-sync', summary: 'Retry pushing a failed change to the provider', tags: ['Events'], middleware: [requireCap('events.write')] }, async (req) => {
    const c = ctx(req);
    const ev = await prisma.calendarEvent.findFirst({ where: { id: req.params.eventId, householdId: c.householdId }, include: { assignments: true } });
    if (!ev || ev.syncState !== 'ERROR') throw notFound('Failed event change');
    const { cal } = await loadCalendarForWrite(c.householdId, c.actor, ev.calendarId);
    const state = ev.deletedAt ? 'PENDING_DELETE' : ev.externalId ? 'PENDING_UPDATE' : 'PENDING_CREATE';
    const updated = await prisma.calendarEvent.update({ where: { id: ev.id }, data: { syncState: state, syncError: null }, include: { assignments: true } });
    afterChange(req, 'event.sync_retried', ev, cal, true);
    return eventDetail(updated);
  });

  // ── Conflicts (sync + schedule) ──
  route(m, { method: 'get', path: '/conflicts', summary: 'Open sync conflicts', tags: ['Events'], middleware: [requireCap('events.write')] }, async (req) => {
    const c = ctx(req);
    const rows = await prisma.eventConflict.findMany({
      where: { householdId: c.householdId, status: 'OPEN' },
      include: { event: { select: { id: true, title: true, calendarId: true, startAt: true, isPrivate: true, createdById: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const out = [];
    for (const r of rows) {
      const visible = await loadCalendarForWrite(c.householdId, c.actor, r.event.calendarId).then(() => true, () => false);
      if (visible) out.push({ id: r.id, type: r.type, details: r.details, createdAt: r.createdAt, event: r.event });
    }
    return out;
  });

  route(
    m,
    {
      method: 'post', path: '/conflicts/:conflictId/resolve', summary: 'Resolve a sync conflict', tags: ['Events'],
      body: z.object({ resolution: z.enum(['keep_local', 'keep_remote', 'dismiss']) }), middleware: [requireCap('events.write')],
    },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const conflictRow = await prisma.eventConflict.findFirst({ where: { id: req.params.conflictId, householdId: c.householdId, status: 'OPEN' } });
      if (!conflictRow) throw notFound('Conflict');
      const ev = await prisma.calendarEvent.findUniqueOrThrow({ where: { id: conflictRow.eventId } });
      const { cal } = await loadCalendarForWrite(c.householdId, c.actor, ev.calendarId);
      if (body.resolution === 'keep_local') {
        await prisma.calendarEvent.update({ where: { id: ev.id }, data: { syncState: ev.externalId ? 'PENDING_UPDATE' : 'PENDING_CREATE', externalEtag: null, syncError: null } });
        if (isTwoWay(cal)) schedulePush(ev.id);
      } else if (body.resolution === 'keep_remote') {
        const remote = (conflictRow.details as { remote?: Record<string, unknown> }).remote;
        await prisma.calendarEvent.update({
          where: { id: ev.id },
          data: {
            ...(remote
              ? {
                  title: String(remote.title ?? ev.title),
                  description: (remote.description as string | null) ?? null,
                  location: (remote.location as string | null) ?? null,
                  startAt: new Date(String(remote.startAt)),
                  endAt: new Date(String(remote.endAt)),
                  externalEtag: (remote.externalEtag as string | null) ?? null,
                }
              : {}),
            syncState: 'SYNCED',
            syncError: null,
            deletedAt: null,
          },
        });
      }
      await prisma.eventConflict.update({
        where: { id: conflictRow.id },
        data: { status: body.resolution === 'dismiss' ? 'DISMISSED' : 'RESOLVED', resolution: body.resolution, resolvedAt: new Date() },
      });
      afterChange(req, 'event.conflict_resolved', ev, cal, false);
      return { ok: true };
    },
  );

  return router;
}
