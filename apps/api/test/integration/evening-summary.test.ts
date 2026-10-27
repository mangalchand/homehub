import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import webpush from 'web-push';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { buildEveningSummary, cleanupSummaryRuns, runEveningSummaries, SUMMARY_LEASE_MS, SUMMARY_TYPE, summaryDedupeKey } from '../../src/jobs/eveningSummary.js';
import { sendFcm } from '../../src/lib/fcm.js';
import { addMember, makeHousehold, resetDb } from './helpers.js';

vi.mock('../../src/lib/fcm.js', () => ({ fcmConfigured: () => true, sendFcm: vi.fn().mockResolvedValue(true) }));
vi.mock('web-push', () => ({ default: { sendNotification: vi.fn().mockResolvedValue({}), setVapidDetails: vi.fn() } }));
vi.mock('../../src/lib/notify.js', async (original) => ({ ...await original<typeof import('../../src/lib/notify.js')>(), vapidKeys: vi.fn().mockResolvedValue({ publicKey: 'test', privateKey: 'test' }) }));

const evening = new Date('2026-10-28T00:30:00.000Z'); // 20:30 New York
const quietPush = vi.fn().mockResolvedValue(undefined);
const options = (now = evening) => ({ clock: () => now, push: quietPush });
const restoreDelegates: (() => void)[] = [];
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); });
afterEach(() => { restoreDelegates.splice(0).forEach((restore) => restore()); });
afterAll(() => prisma.$disconnect());

describe('durable daily summary delivery', () => {
  it('does nothing before the schedule, catches up same-day, and concurrent ticks/restarts deliver once', async () => {
    const { household, ownerMember } = await makeHousehold();
    expect(await runEveningSummaries(options(new Date(evening.getTime() - 1)))).toBe(0);
    expect(await prisma.dailySummaryRun.count()).toBe(0);
    const results = await Promise.all(Array.from({ length: 4 }, () => runEveningSummaries(options())));
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await runEveningSummaries(options(new Date('2026-10-28T03:55:00Z')))).toBe(0);
    const run = await prisma.dailySummaryRun.findFirstOrThrow();
    expect(run).toMatchObject({ status: 'SENT', attempts: 1, leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null });
    expect(run.localDate.toISOString()).toBe('2026-10-27T00:00:00.000Z');
    const notifications = await prisma.notification.findMany();
    expect(notifications).toHaveLength(2);
    expect(notifications.map((n) => n.dedupeKey)).toEqual(expect.arrayContaining([`${summaryDedupeKey(household.id, '2026-10-27')}:feed`, `${summaryDedupeKey(household.id, '2026-10-27')}:${ownerMember.id}`]));
    expect(quietPush).toHaveBeenCalledTimes(1);
  });

  it('uses defaults for new homes, respects disabled settings and custom schedule, and isolates households', async () => {
    const a = await makeHousehold('Default');
    const b = await makeHousehold('Disabled');
    const c = await makeHousehold('Later');
    await prisma.householdFeatureSettings.createMany({ data: [
      { householdId: b.household.id, dailySummaryEnabled: false },
      { householdId: c.household.id, dailySummaryTime: '21:00' },
    ] });
    expect(await runEveningSummaries(options())).toBe(1);
    expect((await prisma.notification.findMany()).every((n) => n.householdId === a.household.id)).toBe(true);
    expect(await runEveningSummaries(options(new Date('2026-10-28T01:00:00Z')))).toBe(1);
    expect(await prisma.dailySummaryRun.count({ where: { householdId: b.household.id } })).toBe(0);
  });

  it('retries actual failed in-app creation with a saved deterministic payload, without duplicates', async () => {
    const { household } = await makeHousehold();
    const task = await prisma.task.create({ data: { householdId: household.id, title: 'Original task' } });
    const createMany = prisma.notification.createMany;
    prisma.notification.createMany = vi.fn(createMany).mockRejectedValueOnce(new Error('private sensitive failure'));
    restoreDelegates.push(() => { prisma.notification.createMany = createMany; });
    expect(await runEveningSummaries(options())).toBe(0);
    const failed = await prisma.dailySummaryRun.findFirstOrThrow();
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, leaseToken: null, leaseExpiresAt: null });
    expect(failed.lastError).not.toContain('sensitive');
    expect(await prisma.notification.count()).toBe(0);
    expect(quietPush).not.toHaveBeenCalled();
    await prisma.task.update({ where: { id: task.id }, data: { title: 'Changed after failure' } });
    expect(await runEveningSummaries(options(new Date(evening.getTime() + 30_000)))).toBe(0);
    expect(await runEveningSummaries(options(new Date(evening.getTime() + 60_000)))).toBe(1);
    const sent = await prisma.dailySummaryRun.findFirstOrThrow();
    expect(sent.payload).toEqual(failed.payload);
    expect(JSON.stringify(sent.payload)).toContain('Original task');
    expect(sent).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    expect(await prisma.notification.count()).toBe(2);
    expect(quietPush).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash after in-app creation without re-notifying or pushing twice', async () => {
    const { household, ownerMember } = await makeHousehold();
    const payload = await buildEveningSummary(household, evening);
    const key = summaryDedupeKey(household.id, '2026-10-27');
    await prisma.notification.createMany({ data: [null, ownerMember.id].map((memberId) => ({ householdId: household.id, memberId, type: SUMMARY_TYPE, title: payload.title, body: payload.body, dedupeKey: `${key}:${memberId ?? 'feed'}` })) });
    await prisma.dailySummaryRun.create({ data: { householdId: household.id, localDate: new Date('2026-10-27'), status: 'CLAIMED', attempts: 1, claimedAt: new Date(evening.getTime() - 2 * SUMMARY_LEASE_MS), leaseExpiresAt: new Date(evening.getTime() - SUMMARY_LEASE_MS), leaseToken: randomUUID(), payload } });
    expect(await runEveningSummaries(options())).toBe(1);
    expect(await prisma.notification.count()).toBe(2);
    expect(quietPush).not.toHaveBeenCalled();
    expect((await prisma.dailySummaryRun.findFirstOrThrow()).status).toBe('SENT');
  });

  it('verifies persistence rather than trusting a reported notification count', async () => {
    await makeHousehold();
    const original = prisma.notification.createMany;
    prisma.notification.createMany = vi.fn(original).mockResolvedValueOnce({ count: 2 });
    restoreDelegates.push(() => { prisma.notification.createMany = original; });
    expect(await runEveningSummaries(options())).toBe(0);
    expect((await prisma.dailySummaryRun.findFirstOrThrow()).status).toBe('FAILED');
    expect(quietPush).not.toHaveBeenCalled();
    expect(await runEveningSummaries(options(new Date(evening.getTime() + 60_000)))).toBe(1);
    expect(await prisma.notification.count()).toBe(2);
  });

  it('rechecks a schedule changed during rendering and sends at the later time, not immediately or never', async () => {
    const { household } = await makeHousehold();
    const original = prisma.task.findMany.bind(prisma.task);
    const findMany: (...args: Parameters<typeof original>) => Promise<Awaited<ReturnType<typeof original>>> = original;
    prisma.task.findMany = vi.fn(findMany).mockImplementationOnce(async (args) => {
      await prisma.householdFeatureSettings.create({ data: { householdId: household.id, dailySummaryTime: '21:00' } });
      return original(args);
    }) as typeof prisma.task.findMany;
    restoreDelegates.push(() => { prisma.task.findMany = original; });
    expect(await runEveningSummaries(options())).toBe(0);
    expect((await prisma.dailySummaryRun.findFirstOrThrow()).status).toBe('PENDING');
    expect(await prisma.notification.count()).toBe(0);
    expect(await runEveningSummaries(options(new Date('2026-10-28T01:00:00Z')))).toBe(1);
    expect((await prisma.dailySummaryRun.findFirstOrThrow()).attempts).toBe(2);
  });

  it('fences a slow expired worker when another worker reclaims its lease', async () => {
    await makeHousehold();
    let current = evening;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const original = prisma.task.findMany.bind(prisma.task);
    const findMany: (...args: Parameters<typeof original>) => Promise<Awaited<ReturnType<typeof original>>> = original;
    prisma.task.findMany = vi.fn(findMany).mockImplementationOnce(async (args) => { started(); await gate; return original(args); }) as typeof prisma.task.findMany;
    restoreDelegates.push(() => { prisma.task.findMany = original; });
    const slow = runEveningSummaries({ clock: () => current, push: quietPush });
    await entered;
    current = new Date(evening.getTime() + SUMMARY_LEASE_MS + 1);
    expect(await runEveningSummaries({ clock: () => current, push: quietPush })).toBe(1);
    release();
    expect(await slow).toBe(0);
    expect((await prisma.dailySummaryRun.findFirstOrThrow()).attempts).toBe(2);
    expect(await prisma.notification.count()).toBe(2);
    expect(quietPush).toHaveBeenCalledTimes(1);
  });

  it('never catches up obsolete days and cleans only expired older leases', async () => {
    const { household } = await makeHousehold();
    await prisma.dailySummaryRun.createMany({ data: [
      { householdId: household.id, localDate: new Date('2026-10-25'), status: 'FAILED', nextAttemptAt: evening },
      { householdId: household.id, localDate: new Date('2026-10-26'), status: 'CLAIMED', claimedAt: new Date(evening.getTime() - SUMMARY_LEASE_MS), leaseExpiresAt: new Date(evening.getTime() - 1), leaseToken: randomUUID() },
      { householdId: household.id, localDate: new Date('2026-10-24'), status: 'CLAIMED', claimedAt: evening, leaseExpiresAt: new Date(evening.getTime() + SUMMARY_LEASE_MS), leaseToken: randomUUID() },
    ] });
    await cleanupSummaryRuns(household.id, household.timezone, evening);
    expect(await prisma.dailySummaryRun.count({ where: { status: 'SKIPPED' } })).toBe(2);
    expect(await prisma.dailySummaryRun.count({ where: { status: 'CLAIMED' } })).toBe(1);
    expect(await runEveningSummaries(options())).toBe(1);
    expect(await prisma.notification.count()).toBe(2);
    expect((await prisma.notification.findFirstOrThrow()).title).toContain('2026-10-27');
  });

  it('abandons a render crossing midnight instead of sending yesterday', async () => {
    await makeHousehold();
    let current = new Date('2026-10-28T03:59:59Z');
    const original = prisma.task.findMany.bind(prisma.task);
    const findMany: (...args: Parameters<typeof original>) => Promise<Awaited<ReturnType<typeof original>>> = original;
    prisma.task.findMany = vi.fn(findMany).mockImplementationOnce(async (args) => { const tasks = await original(args); current = new Date('2026-10-28T04:00:00Z'); return tasks; }) as typeof prisma.task.findMany;
    restoreDelegates.push(() => { prisma.task.findMany = original; });
    expect(await runEveningSummaries({ clock: () => current, push: quietPush })).toBe(0);
    expect((await prisma.dailySummaryRun.findFirstOrThrow()).status).toBe('SKIPPED');
    expect(await prisma.notification.count()).toBe(0);
  });

  it('excludes inactive, expired and muted recipients; uses configured push only and tolerates push failure', async () => {
    const { household, ownerMember } = await makeHousehold();
    const inactive = await addMember(household.id, 'ADULT', 'Inactive');
    const expired = await addMember(household.id, 'GUEST', 'Expired');
    const muted = await addMember(household.id, 'ADULT', 'Muted');
    const noPush = await addMember(household.id, 'ADULT', 'NoPush');
    await prisma.householdMember.update({ where: { id: inactive.member.id }, data: { isActive: false } });
    await prisma.householdMember.update({ where: { id: expired.member.id }, data: { accessExpiresAt: new Date(evening.getTime() - 1) } });
    await prisma.householdMember.update({ where: { id: muted.member.id }, data: { preferences: { notifications: { muted: [SUMMARY_TYPE] } } } });
    await prisma.householdMember.update({ where: { id: noPush.member.id }, data: { preferences: { notifications: { push: false } } } });
    const device = await prisma.device.create({ data: { householdId: household.id, name: 'Kitchen' } });
    const revoked = await prisma.device.create({ data: { householdId: household.id, name: 'Old', revokedAt: new Date() } });
    await prisma.pushSubscription.createMany({ data: [
      ...[ownerMember, inactive.member, expired.member, muted.member, noPush.member].map((m) => ({ householdId: household.id, memberId: m.id, endpoint: `fcm-${m.id}`, kind: 'FCM' })),
      { householdId: household.id, memberId: ownerMember.id, endpoint: 'https://push.test/owner', kind: 'WEB', keys: { p256dh: 'fake', auth: 'fake' } },
      ...[device, revoked].map((d) => ({ householdId: household.id, deviceId: d.id, endpoint: `fcm-${d.id}`, kind: 'FCM' })),
    ] });
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(new Error('offline device'));
    expect(await runEveningSummaries({ clock: () => evening })).toBe(1);
    const rows = await prisma.notification.findMany();
    expect(rows.map((n) => n.memberId)).toEqual(expect.arrayContaining([null, ownerMember.id, noPush.member.id]));
    expect(rows).toHaveLength(3);
    expect(vi.mocked(sendFcm).mock.calls.map((c) => c[0]).sort()).toEqual([`fcm-${device.id}`, `fcm-${ownerMember.id}`].sort());
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect((await prisma.dailySummaryRun.findFirstOrThrow()).status).toBe('SENT');
    expect(await runEveningSummaries({ clock: () => evening })).toBe(0);
    expect(sendFcm).toHaveBeenCalledTimes(2);
  });
});

describe('summary tasks, recurrences and ledger semantics', () => {
  it('lists all pending one-offs and due/overdue occurrences, without completed/approval duplicates, including rotation', async () => {
    const { household, ownerMember } = await makeHousehold();
    const child = await addMember(household.id, 'CHILD', 'Child');
    const other = await makeHousehold('Other household');
    const anchor = DateTime.fromISO('2026-10-25', { zone: household.timezone }).toJSDate();
    const oneoff = await prisma.task.createMany({ data: [
      { householdId: household.id, title: 'Undated task' },
      { householdId: household.id, title: 'Future task', dueAt: new Date('2026-12-01') },
      { householdId: household.id, title: 'Deleted task', deletedAt: new Date() },
      { householdId: household.id, title: 'Done task', status: 'DONE' },
      { householdId: household.id, title: 'Archived task', status: 'ARCHIVED' },
      { householdId: other.household.id, title: 'Other household secret' },
      { householdId: household.id, kind: 'CHORE', title: 'Future chore', dueAt: new Date('2026-12-01') },
    ] });
    expect(oneoff.count).toBe(7);
    const daily = await prisma.task.create({ data: { householdId: household.id, kind: 'CHORE', title: 'Daily chore', dueAt: anchor, rrule: 'FREQ=DAILY', assignments: { create: [{ memberId: child.member.id }] } } });
    await prisma.choreCompletion.createMany({ data: [
      { householdId: household.id, taskId: daily.id, memberId: child.member.id, occurrenceKey: '2026-10-25', status: 'APPROVED' },
      { householdId: household.id, taskId: daily.id, memberId: child.member.id, occurrenceKey: '2026-10-26', status: 'PENDING_APPROVAL' },
      { householdId: household.id, taskId: daily.id, memberId: child.member.id, occurrenceKey: '2026-10-27', status: 'REJECTED' },
    ] });
    await prisma.task.create({ data: { householdId: household.id, kind: 'CHORE', title: 'Monday chore', dueAt: anchor, rrule: 'FREQ=WEEKLY;BYDAY=MO', assignments: { create: [{ memberId: child.member.id }] } } });
    await prisma.task.create({ data: { householdId: household.id, kind: 'CHORE', title: 'Rotating chore', dueAt: anchor, rrule: 'FREQ=DAILY', rotate: true, assignments: { create: [{ memberId: ownerMember.id, position: 0 }, { memberId: child.member.id, position: 1 }] } } });
    const summary = await buildEveningSummary(household, evening);
    expect(summary.body).toContain('2 pending one-off tasks; 5 due/overdue chore occurrences (3 overdue)');
    expect(summary.body).toContain('Undated task (no due date)');
    expect(summary.body).toContain('Future task');
    expect(summary.body).toContain('Daily chore — 2026-10-27 (due today) — Child');
    expect(summary.body).not.toContain('Daily chore — 2026-10-25');
    expect(summary.body).not.toContain('Daily chore — 2026-10-26');
    expect(summary.body).toContain('Monday chore — 2026-10-26 (overdue) — Child');
    expect(summary.body).toContain('Rotating chore — 2026-10-26 (overdue) — Child');
    expect(summary.body).toContain('Rotating chore — 2026-10-27 (due today) — Owner');
    for (const hidden of ['Deleted task', 'Done task', 'Archived task', 'Other household secret', 'Future chore']) expect(summary.body).not.toContain(hidden);
  });

  it('keeps each assigned member outstanding independently and does not cap completions at fifty', async () => {
    const { household, ownerMember } = await makeHousehold();
    const child = await addMember(household.id, 'CHILD', 'Child');
    const chore = await prisma.task.create({ data: { householdId: household.id, kind: 'CHORE', title: 'Shared chore', dueAt: new Date('2026-08-01T04:00:00Z'), rrule: 'FREQ=DAILY', assignments: { create: [{ memberId: ownerMember.id }, { memberId: child.member.id }] } } });
    const dates = Array.from({ length: 88 }, (_, n) => DateTime.fromISO('2026-08-01').plus({ days: n }).toISODate()!);
    await prisma.choreCompletion.createMany({ data: dates.flatMap((date, n) => (n === 87 ? [ownerMember.id] : [ownerMember.id, child.member.id]).map((memberId) => ({ householdId: household.id, taskId: chore.id, memberId, occurrenceKey: date, status: 'APPROVED' as const }))) });
    const { body } = await buildEveningSummary(household, evening);
    expect(body).toContain('1 due/overdue chore occurrences (0 overdue)');
    expect(body).toContain('Shared chore — 2026-10-27 (due today) — Child');
    expect(body).not.toContain('Shared chore — 2026-08-');
  });

  it('uses approved earnings and available balance minus pending reservations, excluding inactive/expired members', async () => {
    const { household, ownerMember } = await makeHousehold();
    const inactive = await addMember(household.id, 'ADULT', 'Inactive');
    const expired = await addMember(household.id, 'GUEST', 'Expired');
    await prisma.householdMember.update({ where: { id: inactive.member.id }, data: { isActive: false } });
    await prisma.householdMember.update({ where: { id: expired.member.id }, data: { accessExpiresAt: new Date(evening.getTime() - 1) } });
    await prisma.rewardTransaction.createMany({ data: [
      { householdId: household.id, memberId: ownerMember.id, type: 'EARN', status: 'APPROVED', points: 100, createdAt: new Date('2026-10-27T12:00:00Z') },
      { householdId: household.id, memberId: ownerMember.id, type: 'EARN', status: 'APPROVED', points: 50, createdAt: new Date('2026-10-26T12:00:00Z') },
      { householdId: household.id, memberId: ownerMember.id, type: 'EARN', status: 'PENDING', points: 999 },
      { householdId: household.id, memberId: ownerMember.id, type: 'REDEEM', status: 'APPROVED', points: -30 },
      { householdId: household.id, memberId: ownerMember.id, type: 'REDEEM', status: 'PENDING', points: -20 },
      { householdId: household.id, memberId: ownerMember.id, type: 'REDEEM', status: 'REJECTED', points: -10 },
      { householdId: household.id, memberId: ownerMember.id, type: 'ADJUST', status: 'APPROVED', points: 5 },
      ...[inactive.member.id, expired.member.id].map((memberId) => ({ householdId: household.id, memberId, type: 'EARN' as const, status: 'APPROVED' as const, points: 10000 })),
    ] });
    const { body } = await buildEveningSummary(household, evening);
    expect(body).toContain('1 active, unexpired members');
    expect(body).toContain('Owner: earned today 100; earned total 150; balance 125; available 105');
    expect(body).toContain('Points totals: 100 earned today; 150 earned total; 105 available');
    expect(body).not.toContain('Inactive:');
    expect(body).not.toContain('Expired:');
  });

  it('counts every pending record while explicitly labelling bounded saved text', async () => {
    const { household } = await makeHousehold();
    await prisma.task.createMany({ data: Array.from({ length: 160 }, (_, n) => ({ householdId: household.id, title: `Task ${n} ${'x'.repeat(180)}` })) });
    const { body } = await buildEveningSummary(household, evening);
    expect(body).toContain('160 pending one-off tasks');
    expect(body).toMatch(/Pending one-off tasks \(including future\/undated\): 160 total; showing \d+; \d+ omitted \(summary size limit\)/);
    expect(body.length).toBeLessThanOrEqual(20000);
  });
});
