import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import webpush from 'web-push';
import type { DailySummaryRun, Household, HouseholdFeatureSettings, Prisma } from '@prisma/client';
import { dailySummaryPayloadSchema, type DailySummaryPayload, type DailySummaryRunDTO } from '@familyhub/shared';
import { prisma } from '../db.js';
import { expandOccurrences } from '../calendar/recurrence.js';
import { pointBalances } from '../routes/tasks.js';
import { notificationPrefs, notify, vapidKeys } from '../lib/notify.js';
import { fcmConfigured, sendFcm } from '../lib/fcm.js';
import { realtime } from '../lib/realtime.js';
import { logger } from '../logger.js';

export const SUMMARY_TYPE = 'summary.daily';
export const SUMMARY_PATH = '/summaries';
export const SUMMARY_LEASE_MS = 5 * 60_000;
export const SUMMARY_DELIVERY_NOTE = 'Sent means saved to the in-app household feed. Configured push is best-effort, not a delivery receipt; an offline device may not receive it. No SMS, WhatsApp or email is sent.';

type Schedule = Pick<HouseholdFeatureSettings, 'dailySummaryEnabled' | 'dailySummaryTime'>;
export const defaultSummarySchedule: Schedule = { dailySummaryEnabled: true, dailySummaryTime: '20:30' };

export function summarySchedule(now: Date, timezone: string, settings: Schedule = defaultSummarySchedule) {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) throw new Error('Invalid household timezone');
  const [hour, minute] = settings.dailySummaryTime.split(':').map(Number);
  const dueAt = local.startOf('day').set({ hour, minute, second: 0, millisecond: 0 });
  const localDate = local.toISODate()!;
  return { localDate, date: new Date(`${localDate}T00:00:00.000Z`), due: settings.dailySummaryEnabled && local >= dueAt };
}

export function summaryRunDTO(run: DailySummaryRun): DailySummaryRunDTO {
  return {
    id: run.id, householdId: run.householdId, localDate: run.localDate.toISOString().slice(0, 10),
    status: run.status, attempts: run.attempts, claimedAt: run.claimedAt?.toISOString() ?? null,
    leaseExpiresAt: run.leaseExpiresAt?.toISOString() ?? null, nextAttemptAt: run.nextAttemptAt?.toISOString() ?? null,
    payload: run.payload ? dailySummaryPayloadSchema.parse(run.payload) : null,
    sentAt: run.sentAt?.toISOString() ?? null, createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(),
  };
}

const clean = (s: string) => Array.from(s, (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c).join('').trim();

function section(title: string, lines: string[], budget: number) {
  let used = 0;
  let shown = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    out.push(line);
    used += line.length + 1;
    shown++;
  }
  return `${title}: ${lines.length} total; showing ${shown}${shown < lines.length ? `; ${lines.length - shown} omitted (summary size limit)` : ''}\n${out.join('\n') || 'None.'}`;
}

export async function buildEveningSummary(household: Pick<Household, 'id' | 'name' | 'timezone'>, now = new Date()): Promise<DailySummaryPayload> {
  const local = DateTime.fromJSDate(now, { zone: household.timezone });
  if (!local.isValid) throw new Error('Invalid household timezone');
  const start = local.startOf('day');
  const end = start.plus({ days: 1 });
  const date = local.toISODate()!;
  const [tasks, members, balances, earned] = await Promise.all([
    prisma.task.findMany({
      where: { householdId: household.id, deletedAt: null, status: 'OPEN' },
      include: { assignments: { orderBy: { position: 'asc' } }, completions: { where: { status: { not: 'REJECTED' } } } },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.householdMember.findMany({
      where: { householdId: household.id, isActive: true, OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: now } }] },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    }),
    pointBalances(household.id),
    prisma.rewardTransaction.groupBy({
      by: ['memberId'], where: { householdId: household.id, type: 'EARN', status: 'APPROVED' }, _sum: { points: true },
    }),
  ]);
  const todayEarned = await prisma.rewardTransaction.groupBy({
    by: ['memberId'], where: { householdId: household.id, type: 'EARN', status: 'APPROVED', createdAt: { gte: start.toJSDate(), lt: end.toJSDate() } }, _sum: { points: true },
  });
  const active = new Map(members.map((m) => [m.id, m]));
  const taskLines: string[] = [];
  const choreLines: string[] = [];
  let overdue = 0;
  for (const task of tasks) {
    const title = clean(task.title);
    if (task.kind === 'TASK' && !task.rrule) {
      const due = task.dueAt ? DateTime.fromJSDate(task.dueAt, { zone: household.timezone }).toFormat('yyyy-MM-dd HH:mm') : 'no due date';
      taskLines.push(`- ${title} (${due}${task.dueAt && task.dueAt < now ? ', overdue' : ''})`);
      continue;
    }
    const anchor = DateTime.fromJSDate(task.dueAt ?? task.createdAt, { zone: household.timezone }).startOf('day');
    if (anchor >= end) continue;
    const dates = task.rrule
      ? expandOccurrences({ startAt: anchor.toJSDate(), endAt: anchor.toJSDate(), timezone: household.timezone, allDay: false, rrule: task.rrule, exdates: [] }, anchor.toJSDate(), end.toJSDate(), Number.MAX_SAFE_INTEGER).map((o) => DateTime.fromJSDate(o.start, { zone: household.timezone }).toISODate()!)
      : [anchor.toISODate()!];
    const done = new Set(task.completions.map((c) => `${c.occurrenceKey}:${c.memberId}`));
    const assignments = task.assignments.map((a) => a.memberId);
    const seenDates = new Set<string>();
    dates.forEach((occurrenceDate, index) => {
      if (seenDates.has(occurrenceDate)) return;
      seenDates.add(occurrenceDate);
      const key = task.rrule ? occurrenceDate : 'once';
      const assigned = task.rotate && assignments.length > 1 ? [assignments[index % assignments.length]!] : assignments;
      const eligible = (assigned.length ? assigned : members.map((m) => m.id)).filter((id) => active.has(id));
      const pending = eligible.filter((id) => !done.has(`${key}:${id}`));
      if (eligible.length && !pending.length) return;
      if (!eligible.length && task.completions.some((c) => c.occurrenceKey === key)) return;
      const names = pending.map((id) => clean(active.get(id)!.displayName)).join(', ');
      const who = names.length > 160 ? `${names.slice(0, 160)}… (${pending.length} pending members total)` : names || 'no active assignee';
      const late = occurrenceDate < date;
      if (late) overdue++;
      choreLines.push(`- ${title} — ${occurrenceDate}${late ? ' (overdue)' : ' (due today)'} — ${who}`);
    });
  }
  let totalEarned = 0;
  let totalToday = 0;
  let totalAvailable = 0;
  const pointLines = members.map((m) => {
    const lifetime = earned.find((r) => r.memberId === m.id)?._sum.points ?? 0;
    const today = todayEarned.find((r) => r.memberId === m.id)?._sum.points ?? 0;
    const balance = balances.get(m.id) ?? { balance: 0, available: 0 };
    totalEarned += lifetime;
    totalToday += today;
    totalAvailable += balance.available;
    return `- ${clean(m.displayName)}: earned today ${today}; earned total ${lifetime}; balance ${balance.balance}; available ${balance.available}`;
  });
  return dailySummaryPayloadSchema.parse({
    title: `Daily household summary — ${date}`,
    generatedAt: now.toISOString(),
    body: [
      `${clean(household.name).slice(0, 200)} · ${date} · ${household.timezone}`,
      `Totals: ${taskLines.length} pending one-off tasks; ${choreLines.length} due/overdue chore occurrences (${overdue} overdue); ${members.length} active, unexpired members.`,
      `Points totals: ${totalToday} earned today; ${totalEarned} earned total; ${totalAvailable} available.`,
      section('Pending one-off tasks (including future/undated)', taskLines, 6500),
      section('Pending chores / recurring tasks (one line per occurrence)', choreLines, 8000),
      section('Member points', pointLines, 3500),
      'Earnings count approved EARN entries only; available = approved ledger balance minus pending reward reservations. Pending approvals are not earned. Chore submissions awaiting approval are not listed as unfinished for that member. Unassigned chores apply to each active member; rotation follows occurrence order. Counts include all records even when lines are omitted.',
      SUMMARY_DELIVERY_NOTE,
    ].join('\n\n'),
  });
}

export function summaryDedupeKey(householdId: string, localDate: string) {
  return `daily-summary:${householdId}:${localDate}`;
}

async function pushSummary(householdId: string, payload: DailySummaryPayload, memberIds: string[], key: string) {
  const members = await prisma.householdMember.findMany({ where: { householdId, id: { in: memberIds }, isActive: true, OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: new Date() } }] } });
  const pushIds = members.filter((m) => notificationPrefs(m.preferences).push && !notificationPrefs(m.preferences).muted?.includes(SUMMARY_TYPE)).map((m) => m.id);
  const subscriptions = await prisma.pushSubscription.findMany({
    where: { householdId, OR: [{ memberId: { in: pushIds } }, { deviceId: { not: null }, device: { revokedAt: null } }] },
  });
  const message = { title: payload.title, body: 'Your saved task and points summary is ready. Open FamilyHub to read it.', url: SUMMARY_PATH, tag: key };
  const web = subscriptions.filter((s) => s.kind === 'WEB');
  if (web.length) await vapidKeys();
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      if (sub.kind === 'WEB') {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } }, JSON.stringify(message), { TTL: 3600, timeout: 10_000 });
      } else if (sub.kind === 'FCM' && fcmConfigured()) {
        const ok = await sendFcm(sub.endpoint, message);
        if (!ok) await prisma.pushSubscription.deleteMany({ where: { id: sub.id, householdId } });
      }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await prisma.pushSubscription.deleteMany({ where: { id: sub.id, householdId } });
      else logger.warn({ householdId, job: SUMMARY_TYPE }, 'summary push failed (best-effort)');
    }
  }));
}

export interface SummaryWorkerOptions {
  clock?: () => Date;
  push?: typeof pushSummary;
}

function leaseWhere(run: DailySummaryRun, token: string, now: Date): Prisma.DailySummaryRunWhereInput {
  return { id: run.id, householdId: run.householdId, status: 'CLAIMED', leaseToken: token, leaseExpiresAt: { gt: now } };
}

/** Expired claims can be reclaimed today. Older, unfinished runs are terminal and never delivered. */
export async function cleanupSummaryRuns(householdId: string, timezone: string, now = new Date()) {
  const { date } = summarySchedule(now, timezone);
  return prisma.dailySummaryRun.updateMany({
    where: { householdId, localDate: { lt: date }, OR: [{ status: { in: ['PENDING', 'FAILED'] } }, { status: 'CLAIMED', leaseExpiresAt: { lte: now } }] },
    data: { status: 'SKIPPED', leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null, lastError: null },
  });
}

async function processHousehold(household: Household, options: SummaryWorkerOptions) {
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  await cleanupSummaryRuns(household.id, household.timezone, now);
  const settings = await prisma.householdFeatureSettings.findUnique({ where: { householdId: household.id } });
  const schedule = summarySchedule(now, household.timezone, settings ?? defaultSummarySchedule);
  if (!schedule.due) return false;
  await prisma.dailySummaryRun.upsert({
    where: { householdId_localDate: { householdId: household.id, localDate: schedule.date } },
    create: { householdId: household.id, localDate: schedule.date, nextAttemptAt: now }, update: {},
  });
  const token = randomUUID();
  const claimed = await prisma.dailySummaryRun.updateMany({
    where: { householdId: household.id, localDate: schedule.date, OR: [
      { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now } },
      { status: 'CLAIMED', leaseExpiresAt: { lte: now } },
    ] },
    data: { status: 'CLAIMED', leaseToken: token, claimedAt: now, leaseExpiresAt: new Date(now.getTime() + SUMMARY_LEASE_MS), nextAttemptAt: null, attempts: { increment: 1 }, lastError: null },
  });
  if (!claimed.count) return false;
  const run = await prisma.dailySummaryRun.findUniqueOrThrow({ where: { householdId_localDate: { householdId: household.id, localDate: schedule.date } } });
  try {
    const payload = run.payload ? dailySummaryPayloadSchema.parse(run.payload) : await buildEveningSummary(household, clock());
    const beforeDelivery = clock();
    const currentHousehold = await prisma.household.findUniqueOrThrow({ where: { id: household.id }, include: { featureSettings: true } });
    const current = summarySchedule(beforeDelivery, currentHousehold.timezone, currentHousehold.featureSettings ?? defaultSummarySchedule);
    if (current.localDate !== schedule.localDate || !current.due) {
      const sameDay = current.localDate === schedule.localDate;
      await prisma.dailySummaryRun.updateMany({
        where: leaseWhere(run, token, beforeDelivery),
        data: { status: sameDay ? 'PENDING' : 'SKIPPED', nextAttemptAt: sameDay ? beforeDelivery : null, leaseToken: null, leaseExpiresAt: null },
      });
      return false;
    }
    const saved = await prisma.dailySummaryRun.updateMany({
      where: leaseWhere(run, token, beforeDelivery),
      data: { payload, leaseExpiresAt: new Date(beforeDelivery.getTime() + SUMMARY_LEASE_MS) },
    });
    if (!saved.count) return false;
    const members = await prisma.householdMember.findMany({ where: { householdId: household.id, userId: { not: null }, isActive: true, OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: beforeDelivery } }] } });
    const recipients = members.filter((m) => !notificationPrefs(m.preferences).muted?.includes(SUMMARY_TYPE)).map((m) => m.id);
    const key = summaryDedupeKey(household.id, schedule.localDate);
    const deliveryAt = clock();
    if (summarySchedule(deliveryAt, currentHousehold.timezone).localDate !== schedule.localDate || deliveryAt.getTime() >= beforeDelivery.getTime() + SUMMARY_LEASE_MS) return false;
    const created = await notify(household.id, {
      type: SUMMARY_TYPE, title: payload.title, body: payload.body, url: SUMMARY_PATH,
      data: { summaryRunId: run.id, localDate: schedule.localDate }, householdFeed: true, external: false,
    }, { to: recipients, dedupeKey: key });
    // notify deliberately swallows failures; verify the durable feed and every still-eligible recipient.
    const keys = [`${key}:feed`, ...recipients.map((id) => `${key}:${id}`)];
    const persisted = await prisma.notification.count({ where: { householdId: household.id, dedupeKey: { in: keys } } });
    if (persisted !== keys.length) throw new Error('Summary in-app persistence incomplete');
    const finished = await prisma.dailySummaryRun.updateMany({
      where: leaseWhere(run, token, clock()),
      data: { status: 'SENT', sentAt: clock(), nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null, lastError: null },
    });
    if (!finished.count) return false;
    realtime.publish(household.id, { type: 'summaries.changed', entityId: run.id });
    if (created > 0) {
      try { await (options.push ?? pushSummary)(household.id, payload, recipients, key); }
      catch { logger.warn({ householdId: household.id, job: SUMMARY_TYPE }, 'summary push failed (best-effort)'); }
    }
    return true;
  } catch {
    const failedAt = clock();
    const sameDay = summarySchedule(failedAt, household.timezone).localDate === schedule.localDate;
    await prisma.dailySummaryRun.updateMany({
      where: leaseWhere(run, token, failedAt),
      data: {
        status: sameDay ? 'FAILED' : 'SKIPPED', leaseToken: null, leaseExpiresAt: null,
        nextAttemptAt: sameDay ? new Date(failedAt.getTime() + Math.min(30, 2 ** Math.min(run.attempts - 1, 5)) * 60_000) : null,
        lastError: sameDay ? 'Summary generation or in-app persistence failed; scheduled retry.' : null,
      },
    });
    return false;
  }
}

/** Each local day has one durable run; safe across concurrent scheduler/API/worker processes. */
export async function runEveningSummaries(options: SummaryWorkerOptions = {}) {
  let sent = 0;
  let cursor: string | undefined;
  for (;;) {
    const households = await prisma.household.findMany({ orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!households.length) break;
    for (const household of households) {
      try { if (await processHousehold(household, options)) sent++; }
      catch { logger.warn({ householdId: household.id, job: SUMMARY_TYPE }, 'summary tick failed; will retry next tick'); }
    }
    cursor = households[households.length - 1]!.id;
  }
  return sent;
}
