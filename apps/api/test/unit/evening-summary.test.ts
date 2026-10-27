import { describe, expect, it } from 'vitest';
import { summarySchedule } from '../../src/jobs/eveningSummary.js';

describe('daily summary local schedule', () => {
  it.each([
    ['2026-10-27T18:29:59Z', 'Europe/Paris', false, '2026-10-27'],
    ['2026-10-27T19:29:59Z', 'Europe/Paris', false, '2026-10-27'],
    ['2026-10-27T19:30:00Z', 'Europe/Paris', true, '2026-10-27'],
    ['2026-10-28T00:15:00Z', 'America/New_York', false, '2026-10-27'],
    ['2026-10-28T00:30:00Z', 'America/New_York', true, '2026-10-27'],
    ['2026-10-28T03:59:00Z', 'America/New_York', true, '2026-10-27'],
    ['2026-10-28T04:00:00Z', 'America/New_York', false, '2026-10-28'],
    ['2026-10-27T14:45:00Z', 'Asia/Kathmandu', true, '2026-10-27'],
    ['2026-10-27T06:30:00Z', 'Pacific/Kiritimati', true, '2026-10-27'],
    ['2026-03-09T00:30:00Z', 'America/New_York', true, '2026-03-08'],
    ['2026-11-02T01:30:00Z', 'America/New_York', true, '2026-11-01'],
  ])('%s in %s has due=%s on %s', (instant, zone, due, localDate) => {
    const result = summarySchedule(new Date(instant), zone);
    expect(result.due).toBe(due);
    expect(result.localDate).toBe(localDate);
    expect(result.date.toISOString()).toBe(`${localDate}T00:00:00.000Z`);
  });

  it('respects disabled and custom time, including DST gaps and folds', () => {
    expect(summarySchedule(new Date('2026-10-28T03:00:00Z'), 'America/New_York', { dailySummaryEnabled: false, dailySummaryTime: '20:30' }).due).toBe(false);
    expect(summarySchedule(new Date('2026-10-27T13:44:00Z'), 'Asia/Kathmandu', { dailySummaryEnabled: true, dailySummaryTime: '19:30' }).due).toBe(false);
    expect(summarySchedule(new Date('2026-10-27T13:45:00Z'), 'Asia/Kathmandu', { dailySummaryEnabled: true, dailySummaryTime: '19:30' }).due).toBe(true);
    expect(summarySchedule(new Date('2026-03-08T07:30:00Z'), 'America/New_York', { dailySummaryEnabled: true, dailySummaryTime: '02:30' }).due).toBe(true);
    expect(summarySchedule(new Date('2026-11-01T06:30:00Z'), 'America/New_York', { dailySummaryEnabled: true, dailySummaryTime: '01:30' }).due).toBe(true);
    expect(() => summarySchedule(new Date(), 'Not/AZone')).toThrow('Invalid household timezone');
  });
});
