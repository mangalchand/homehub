import { describe, expect, it } from 'vitest';
import { categorizeGrocery } from '../../src/lib/grocery.js';
import { occurrenceFor } from '../../src/routes/tasks.js';

describe('grocery categorizer', () => {
  it.each([
    ['Strawberries', 'Produce'],
    ['2% milk', 'Dairy & Eggs'],
    ['Paper towels', 'Household'],
    ['Mystery item', null],
  ])('%s → %s', (name, cat) => expect(categorizeGrocery(name)).toBe(cat));
});

describe('chore occurrences', () => {
  const tz = 'America/New_York';
  const created = new Date('2026-10-19T12:00:00Z'); // Monday
  it('non-recurring tasks use a single occurrence key', () => {
    expect(occurrenceFor({ rrule: null, dueAt: null, createdAt: created }, '2026-10-24', tz)).toEqual({ key: 'once', due: true, index: 0 });
  });
  it('weekly chores are only due on their day and rotate by occurrence index', () => {
    const t = { rrule: 'FREQ=WEEKLY;BYDAY=TU', dueAt: created, createdAt: created };
    expect(occurrenceFor(t, '2026-10-26', tz).due).toBe(false);
    expect(occurrenceFor(t, '2026-10-20', tz)).toMatchObject({ due: true, index: 0, key: '2026-10-20' });
    expect(occurrenceFor(t, '2026-10-27', tz)).toMatchObject({ due: true, index: 1 });
    expect(occurrenceFor(t, '2026-10-12', tz).due).toBe(false);
  });
});
