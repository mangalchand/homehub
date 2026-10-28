import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { runDailyAnnouncements } from '../../src/jobs/dailyAnnouncements.js';
import { makeHousehold, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('daily announcement scheduling', () => {
  it('notifies at the household-local time once per local day, including concurrent scheduler ticks', async () => {
    const { household } = await makeHousehold();
    const item = await prisma.announcement.create({
      data: { householdId: household.id, title: 'Medicine time', repeatDaily: true, dailyTime: '08:30' },
    });
    expect(await runDailyAnnouncements(new Date('2026-10-27T12:29:00.000Z'))).toBe(0);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runDailyAnnouncements(new Date('2026-10-27T12:30:00.000Z'))),
    );
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(
      await prisma.notification.count({ where: { householdId: household.id, type: 'announcement.daily' } }),
    ).toBe(2);
    expect(await runDailyAnnouncements(new Date('2026-10-27T18:00:00.000Z'))).toBe(0);
    expect(await runDailyAnnouncements(new Date('2026-10-28T12:30:00.000Z'))).toBe(1);
    const updated = await prisma.announcement.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.lastNotifiedLocalDate?.toISOString()).toBe('2026-10-28T00:00:00.000Z');
    expect(
      await prisma.notification.count({ where: { householdId: household.id, type: 'announcement.daily' } }),
    ).toBe(4);
  });
});
