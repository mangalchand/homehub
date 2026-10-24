import type { Prisma } from '@prisma/client';
import type { Actor, CalendarAccess, CalendarDTO, EventOccurrenceDTO } from '@familyhub/shared';
import { prisma } from '../db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { calendarAccess, eventView, readOnlyReason, type CalendarWithAccess } from './access.js';
import { describeRule, expandOccurrences } from './recurrence.js';

export const calendarInclude = {
  shares: true,
  connection: { include: { syncState: true, account: { select: { status: true, externalAccountId: true, email: true } } } },
} satisfies Prisma.CalendarInclude;

export type LoadedCalendar = Prisma.CalendarGetPayload<{ include: typeof calendarInclude }>;

export async function visibleCalendars(householdId: string, actor: Actor) {
  const cals = await prisma.calendar.findMany({
    where: { householdId, deletedAt: null },
    include: calendarInclude,
    orderBy: [{ createdAt: 'asc' }],
  });
  return cals
    .map((cal) => ({ cal, access: calendarAccess(actor, cal as CalendarWithAccess) }))
    .filter((c) => c.access !== 'NONE');
}

export function calendarDTO(cal: LoadedCalendar, access: CalendarAccess): CalendarDTO & Record<string, unknown> {
  const conn = cal.connection;
  return {
    id: cal.id,
    name: cal.name,
    description: cal.description,
    color: cal.color,
    category: cal.category,
    source: cal.source,
    visibility: cal.visibility,
    showOnWallDisplay: cal.showOnWallDisplay,
    ownerMemberId: cal.ownerMemberId,
    access,
    readOnlyReason: readOnlyReason(cal as CalendarWithAccess),
    shares: access === 'WRITE' ? cal.shares.map((s) => ({ memberId: s.memberId, access: s.access })) : undefined,
    accountEmail: conn?.account?.email ?? null,
    isDemo: Boolean(conn?.account?.externalAccountId.startsWith('demo:')),
    sync: conn
      ? {
          connectionId: conn.id,
          syncMode: conn.syncMode,
          status: conn.syncState?.status ?? 'IDLE',
          lastSuccessAt: conn.syncState?.lastSuccessAt?.toISOString() ?? null,
          lastError: conn.syncState?.lastError ?? null,
          nextSyncAt: conn.syncState?.nextSyncAt?.toISOString() ?? null,
          accountStatus: conn.account?.status ?? null,
          refreshIntervalMinutes: conn.refreshIntervalMinutes,
          enabled: conn.enabled,
        }
      : undefined,
  };
}

export async function loadCalendar(householdId: string, actor: Actor, calendarId: string) {
  const cal = await prisma.calendar.findFirst({ where: { id: calendarId, householdId, deletedAt: null }, include: calendarInclude });
  if (!cal) throw notFound('Calendar');
  const access = calendarAccess(actor, cal as CalendarWithAccess);
  if (access === 'NONE') throw notFound('Calendar');
  return { cal, access };
}

export async function loadCalendarForWrite(householdId: string, actor: Actor, calendarId: string) {
  const r = await loadCalendar(householdId, actor, calendarId);
  if (r.access !== 'WRITE') throw forbidden(readOnlyReason(r.cal as CalendarWithAccess) ?? 'You cannot add or edit events on this calendar');
  return r;
}

/** Can the actor change calendar settings (owner of a personal calendar or a household calendar manager)? */
export function canManageCalendar(actor: Actor, cal: LoadedCalendar, hasManageCap: boolean) {
  if (actor.kind !== 'member') return false;
  return hasManageCap || (cal.ownerMemberId !== null && cal.ownerMemberId === actor.memberId);
}

export interface RangeQuery {
  start: Date;
  end: Date;
  calendarIds?: string[];
  memberIds?: string[];
  q?: string;
}

const MAX_RANGE_MS = 400 * 86400000;

type EventRow = Prisma.CalendarEventGetPayload<{ include: { assignments: { select: { memberId: true } } } }>;

/**
 * Expand events for a date range into occurrences the actor may see. Privacy is applied here, so busy-only
 * occurrences never include titles, descriptions, locations or attendees.
 */
export async function listOccurrences(householdId: string, actor: Actor, range: RangeQuery): Promise<EventOccurrenceDTO[]> {
  if (range.end <= range.start) throw badRequest('end must be after start');
  if (range.end.getTime() - range.start.getTime() > MAX_RANGE_MS) throw badRequest('Date range is too large (max 400 days)');
  let cals = await visibleCalendars(householdId, actor);
  if (range.calendarIds?.length) cals = cals.filter((c) => range.calendarIds!.includes(c.cal.id));
  if (!cals.length) return [];
  const calMap = new Map(cals.map((c) => [c.cal.id, c]));

  const rows: EventRow[] = await prisma.calendarEvent.findMany({
    where: {
      householdId,
      calendarId: { in: [...calMap.keys()] },
      deletedAt: null,
      OR: [
        { rrule: { not: null }, recurringEventId: null, startAt: { lt: range.end } },
        { rrule: null, recurringEventId: null, startAt: { lt: range.end }, endAt: { gte: range.start } },
        { recurringEventId: { not: null } },
      ],
    },
    include: { assignments: { select: { memberId: true } } },
  });

  const masters = new Map(rows.filter((r) => r.rrule && !r.recurringEventId).map((r) => [r.id, r]));
  const overrides = rows.filter((r) => r.recurringEventId);
  const overrideKeys = new Set(overrides.map((o) => `${o.recurringEventId}|${o.originalStartAt?.getTime()}`));

  const out: EventOccurrenceDTO[] = [];
  const emit = (ev: EventRow, start: Date, end: Date, occId: string, isRecurring: boolean, rrule: string | null, originalStart: Date | null) => {
    const c = calMap.get(ev.calendarId)!;
    const view = eventView(actor, c.cal as CalendarWithAccess, c.access, ev);
    if (!view.visible || ev.status === 'CANCELLED') return;
    const memberIds = ev.assignments.map((a) => a.memberId);
    if (range.memberIds?.length && !memberIds.some((m) => range.memberIds!.includes(m))) return;
    if (range.q && (view.busyOnly || !ev.title.toLowerCase().includes(range.q.toLowerCase()))) return;
    out.push({
      id: occId,
      eventId: ev.id,
      calendarId: ev.calendarId,
      title: view.busyOnly ? 'Busy' : ev.title,
      description: view.busyOnly ? null : ev.description,
      location: view.busyOnly ? null : ev.location,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      allDay: ev.allDay,
      timezone: ev.timezone,
      isRecurring,
      rrule: view.busyOnly ? null : rrule,
      recurrenceText: rrule && !view.busyOnly ? describeRule(rrule) : null,
      originalStartAt: originalStart?.toISOString() ?? null,
      isPrivate: ev.isPrivate,
      busyOnly: view.busyOnly,
      color: ev.color ?? c.cal.color,
      category: view.busyOnly ? null : ev.category,
      memberIds,
      canEdit: view.canEdit,
      syncState: ev.syncState,
      syncError: view.busyOnly ? null : ev.syncError,
      version: ev.version,
      conflictsWith: [],
    } as EventOccurrenceDTO);
  };

  for (const ev of rows) {
    if (ev.recurringEventId) continue;
    if (!ev.rrule) {
      emit(ev, ev.startAt, ev.endAt, ev.id, false, null, null);
      continue;
    }
    for (const occ of expandOccurrences(ev, range.start, range.end)) {
      if (overrideKeys.has(`${ev.id}|${occ.originalStart.getTime()}`)) continue;
      emit(ev, occ.start, occ.end, `${ev.id}::${occ.originalStart.toISOString()}`, true, ev.rrule, occ.originalStart);
    }
  }
  for (const ov of overrides) {
    const master = masters.get(ov.recurringEventId!);
    if (!master && ov.recurringEventId) {
      // Master outside the fetched set (deleted); only show if the master still exists.
      continue;
    }
    if (ov.startAt >= range.end || ov.endAt < range.start) continue;
    emit(ov, ov.startAt, ov.endAt, ov.id, true, master?.rrule ?? null, ov.originalStartAt);
  }

  out.sort((a, b) => a.startAt.localeCompare(b.startAt) || Number(b.allDay) - Number(a.allDay));
  markScheduleConflicts(out);
  return out;
}

/** Flag overlapping timed occurrences that share an assigned family member. */
export function markScheduleConflicts(occ: EventOccurrenceDTO[]) {
  const timed = occ.filter((o) => !o.allDay && o.memberIds.length);
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i]!;
    const aEnd = Date.parse(a.endAt);
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j]!;
      if (Date.parse(b.startAt) >= aEnd) break;
      if (a.memberIds.some((m) => b.memberIds.includes(m))) {
        a.conflictsWith.push(b.id);
        b.conflictsWith.push(a.id);
      }
    }
  }
}
