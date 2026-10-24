import { describe, expect, it } from 'vitest';
import { fromTzInput, toTzInput, zoned } from '../time';

describe('household timezone helpers', () => {
  it('round-trips a wall-clock value in a named zone', () => {
    const d = fromTzInput('2026-03-08T09:30', 'America/New_York');
    expect(d.toISOString()).toBe('2026-03-08T13:30:00.000Z');
    expect(toTzInput(d, 'America/New_York', false)).toBe('2026-03-08T09:30');
  });
  it('handles the DST change correctly', () => {
    expect(fromTzInput('2026-03-07T09:30', 'America/New_York').toISOString()).toBe('2026-03-07T14:30:00.000Z');
  });
  it('produces a Date whose local fields match the zone', () => {
    const z = zoned('2026-10-24T23:30:00Z', 'Asia/Tokyo');
    expect([z.getDate(), z.getHours(), z.getMinutes()]).toEqual([25, 8, 30]);
  });
  it('formats all-day dates', () => {
    expect(toTzInput(new Date('2026-12-25T00:00:00Z'), 'UTC', true)).toBe('2026-12-25');
  });
});
