import { describe, expect, it } from 'vitest';
import { expandOccurrences, isOccurrenceOf, truncateRule } from '../../src/calendar/recurrence.js';

const ny = (start: string, end: string, rrule: string | null, exdates: Date[] = []) => ({
  startAt: new Date(start), endAt: new Date(end), allDay: false, timezone: 'America/New_York', rrule, exdates,
});

describe('recurrence expansion', () => {
  it('keeps local wall-clock time across the DST change', () => {
    // 9:00 EDT (UTC-4) on Mon 26 Oct 2026; DST ends 1 Nov 2026.
    const src = ny('2026-10-26T13:00:00Z', '2026-10-26T14:00:00Z', 'FREQ=WEEKLY;BYDAY=MO');
    const occ = expandOccurrences(src, new Date('2026-10-25T00:00:00Z'), new Date('2026-11-10T00:00:00Z'));
    expect(occ.map((o) => o.start.toISOString())).toEqual(['2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-09T14:00:00.000Z']);
    expect(occ.every((o) => o.end.getTime() - o.start.getTime() === 3600_000)).toBe(true);
  });

  it('honours EXDATE exceptions', () => {
    const src = ny('2026-10-26T13:00:00Z', '2026-10-26T14:00:00Z', 'FREQ=DAILY;COUNT=3', [new Date('2026-10-27T13:00:00Z')]);
    const occ = expandOccurrences(src, new Date('2026-10-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    expect(occ.map((o) => o.start.toISOString())).toEqual(['2026-10-26T13:00:00.000Z', '2026-10-28T13:00:00.000Z']);
  });

  it('includes events that started before the range but overlap it', () => {
    const src = ny('2026-10-26T13:00:00Z', '2026-10-26T15:00:00Z', null);
    expect(expandOccurrences(src, new Date('2026-10-26T14:00:00Z'), new Date('2026-10-27T00:00:00Z'))).toHaveLength(1);
    expect(expandOccurrences(src, new Date('2026-10-26T15:00:00Z'), new Date('2026-10-27T00:00:00Z'))).toHaveLength(0);
  });

  it('recognises occurrences and truncates for "this and following" edits', () => {
    const src = ny('2026-10-26T13:00:00Z', '2026-10-26T14:00:00Z', 'FREQ=WEEKLY;BYDAY=MO');
    expect(isOccurrenceOf(src, new Date('2026-11-02T14:00:00Z'))).toBe(true);
    expect(isOccurrenceOf(src, new Date('2026-11-03T14:00:00Z'))).toBe(false);
    const truncated = truncateRule('FREQ=WEEKLY;BYDAY=MO', new Date('2026-11-09T14:00:00Z'));
    expect(truncated).toMatch(/UNTIL=/);
    const occ = expandOccurrences({ ...src, rrule: truncated }, new Date('2026-10-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'));
    expect(occ).toHaveLength(2);
  });
});
