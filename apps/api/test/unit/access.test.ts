import { describe, expect, it } from 'vitest';
import type { Actor } from '@familyhub/shared';
import { calendarAccess, eventView, readOnlyReason, type CalendarWithAccess } from '../../src/calendar/access.js';

const cal = (over: Partial<CalendarWithAccess> = {}) =>
  ({
    id: 'c1', deletedAt: null, source: 'INTERNAL', isReadOnly: false, connection: null, showOnWallDisplay: true,
    visibility: 'HOUSEHOLD', ownerMemberId: null, shares: [], ...over,
  }) as unknown as CalendarWithAccess;
const member = (role: 'OWNER' | 'ADULT' | 'CHILD' | 'GUEST', memberId = `m-${role}`): Actor => ({ kind: 'member', role, memberId, userId: `u-${role}` });
const device = (elevated = false): Actor => ({ kind: 'device', deviceId: 'd1', elevated });

describe('calendar access', () => {
  it('household calendars: adults write, children and guests read', () => {
    expect(calendarAccess(member('ADULT'), cal())).toBe('WRITE');
    expect(calendarAccess(member('CHILD'), cal())).toBe('READ');
    expect(calendarAccess(member('GUEST'), cal())).toBe('READ');
  });

  it('private calendars are invisible to everyone but the owner (including the household owner role)', () => {
    const c = cal({ visibility: 'PRIVATE', ownerMemberId: 'alice' });
    expect(calendarAccess(member('OWNER'), c)).toBe('NONE');
    expect(calendarAccess(member('ADULT', 'alice'), c)).toBe('WRITE');
    expect(calendarAccess(device(true), c)).toBe('NONE');
  });

  it('busy-only calendars only expose busy blocks', () => {
    const c = cal({ visibility: 'BUSY_ONLY', ownerMemberId: 'sam' });
    const viewer = member('OWNER');
    const access = calendarAccess(viewer, c);
    expect(access).toBe('BUSY');
    const v = eventView(viewer, c, access, { isPrivate: false, createdById: 'u-sam' });
    expect(v.busyOnly).toBe(true);
    expect(v.canEdit).toBe(false);
  });

  it('selected sharing respects grants and caps children at read', () => {
    const c = cal({ visibility: 'SELECTED', ownerMemberId: 'o', shares: [{ memberId: 'kid', access: 'WRITE' }, { memberId: 'pal', access: 'READ' }] as never });
    expect(calendarAccess(member('CHILD', 'kid'), c)).toBe('READ');
    expect(calendarAccess(member('ADULT', 'pal'), c)).toBe('READ');
    expect(calendarAccess(member('ADULT', 'stranger'), c)).toBe('NONE');
  });

  it('wall displays read only unless PIN-elevated, and never write external calendars', () => {
    expect(calendarAccess(device(false), cal())).toBe('READ');
    expect(calendarAccess(device(true), cal())).toBe('WRITE');
    expect(calendarAccess(device(true), cal({ source: 'GOOGLE', connection: { syncMode: 'TWO_WAY' } as never }))).toBe('READ');
    expect(calendarAccess(device(), cal({ showOnWallDisplay: false }))).toBe('NONE');
  });

  it('ICS and read-only provider calendars are never writable', () => {
    expect(readOnlyReason(cal({ source: 'ICS_URL' }))).toBeTruthy();
    expect(calendarAccess(member('OWNER'), cal({ source: 'ICS_FILE' }))).toBe('READ');
    expect(calendarAccess(member('OWNER'), cal({ source: 'MICROSOFT', connection: { syncMode: 'READ_ONLY' } as never }))).toBe('READ');
    expect(calendarAccess(member('OWNER'), cal({ source: 'MICROSOFT', connection: { syncMode: 'TWO_WAY' } as never }))).toBe('WRITE');
  });
});
