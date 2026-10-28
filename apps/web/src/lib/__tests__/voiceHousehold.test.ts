import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberDTO } from '@familyhub/shared';
import type { Me, Announcement, Task } from '../queries';
import { ApiRequestError, api } from '../api';
import { activeAnnouncements, announcementReading, canAnnounce, deviceNotifications, notificationReading, pendingTasksReading, pointsReading, readNotifications, readPoints, voiceError, voiceScope, type FeedNotification } from '../voice/household';
import { runVoiceCommand } from '@/features/voice';

vi.mock('../api', async (original) => ({ ...await original<typeof import('../api')>(), api: vi.fn() }));
vi.mock('../queryClient', () => ({ queryClient: { invalidateQueries: vi.fn() } }));

const device = (elevated = false): Me => ({ kind: 'device', device: { id: 'd', householdId: 'h', name: 'Kitchen' }, memberships: [], session: { id: 's', pinElevatedUntil: elevated ? new Date(Date.now() + 60_000).toISOString() : null } });
const user = (role = 'ADULT'): Me => ({ kind: 'user', user: { id: 'u', email: 'local@example.test', displayName: 'Parent', hasPassword: true, emailVerified: true }, memberships: [{ householdId: 'h', householdName: 'Home', memberId: 'm', role }], session: { id: 's', pinElevatedUntil: null } });
const members = [{ id: 'm', firstName: 'Mary', displayName: 'Mary Jane', isActive: true }, { id: 'l', firstName: 'Leo', displayName: 'Leo', isActive: true }] as MemberDTO[];
const points = [{ memberId: 'm', available: 75, balance: 100, pending: -15 }, { memberId: 'l', available: 0, balance: 0, pending: 0 }];
const announcement = (id: string, options: Partial<Announcement> = {}): Announcement => ({ id, title: id, body: null, priority: 'NORMAL', pinned: false, color: null, expiresAt: null, createdAt: '2026-10-26T12:00:00Z', ...options });
const notification = (id: string, options: Partial<FeedNotification> = {}): FeedNotification => ({ id, householdId: 'h', memberId: null, title: id, body: 'Details', type: 'announcement', readAt: null, data: {}, createdAt: new Date().toISOString(), ...options });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api).mockImplementation(async (url) => {
    if (url === '/api/v1/auth/me') return user();
    if (url.endsWith('/members')) return members;
    if (url.endsWith('/points')) return points;
    return [];
  });
});

describe('announcement authority', () => {
  it('uses existing roles/PIN capabilities and fixes displays to the paired home', () => {
    expect(canAnnounce(user('ADULT'), 'h')).toBe(true);
    expect(canAnnounce(user('CHILD'), 'h')).toBe(false);
    expect(canAnnounce(user('GUEST'), 'h')).toBe(false);
    expect(canAnnounce(device(), 'h')).toBe(false);
    expect(canAnnounce(device(true), 'h')).toBe(true);
    expect(canAnnounce(device(true), 'other')).toBe(false);
    expect(voiceScope(device(true), 'other')).toBeNull();
    const expired = device(true); expired.session.pinElevatedUntil = new Date(Date.now() - 1).toISOString();
    expect(canAnnounce(expired, 'h')).toBe(false);
  });
  it.each([device(), user('CHILD'), user('GUEST')])('never posts when session lacks announcements.write', async (me) => {
    vi.mocked(api).mockResolvedValue(me);
    await expect(runVoiceCommand('h', { kind: 'announce', title: 'Dinner is ready' }, 'UTC')).rejects.toThrow(/PIN|permission/);
    expect(api).toHaveBeenCalledTimes(1);
  });
  it('posts only through the existing secured endpoint after fresh session validation', async () => {
    vi.mocked(api).mockResolvedValueOnce(device(true)).mockResolvedValueOnce({});
    expect(await runVoiceCommand('h', { kind: 'announce', title: 'Dinner is ready' }, 'UTC')).toContain('Announcement posted');
    expect(api).toHaveBeenLastCalledWith('/api/v1/households/h/announcements', { method: 'POST', body: { title: 'Dinner is ready', priority: 'NORMAL', pinned: false } });
  });
  it('does not turn backend rejection or expired PIN into success', async () => {
    vi.mocked(api).mockResolvedValueOnce(device(true)).mockRejectedValueOnce(new ApiRequestError(403, 'FORBIDDEN', 'Enter PIN'));
    await expect(runVoiceCommand('h', { kind: 'announce', title: 'Dinner' }, 'UTC')).rejects.toMatchObject({ status: 403 });
    expect(voiceError(new ApiRequestError(403, 'FORBIDDEN', 'Denied'), true)).toContain('PIN');
    expect(voiceError(new ApiRequestError(403, 'FORBIDDEN', 'Denied'), false)).not.toContain('PIN');
  });
  it('rejects overlong announcement commands and cancelled work before writing', async () => {
    await expect(runVoiceCommand('h', { kind: 'announce', title: 'a'.repeat(141) }, 'UTC')).rejects.toThrow('140');
    expect(api).toHaveBeenCalledTimes(1);
    await expect(runVoiceCommand('h', { kind: 'announce', title: 'Dinner' }, 'UTC', () => false)).rejects.toThrow('cancelled');
    expect(api).toHaveBeenCalledTimes(1);
  });
});

describe('accurate household readouts', () => {
  it('reads available, approved balance, reservation and actual pending earnings separately', () => {
    expect(pointsReading(members, points, 'm')).toBe('Mary Jane has 75 points available, from a balance of 100. 25 points are reserved for reward requests. 10 earned points are awaiting approval.');
    expect(pointsReading(members, points, 'l')).toContain('0 points available');
    expect(pointsReading(members, [], 'm')).toContain('unavailable');
  });
  it('resolves my points for members but never invents a shared display identity', async () => {
    expect(await readPoints('h')).toContain('Mary Jane has 75');
    vi.mocked(api).mockResolvedValueOnce(device());
    expect(await readPoints('h')).toContain('named member');
    expect(await readPoints('h', { memberName: 'mary jane' })).toContain('Mary Jane has 75');
    expect(await readPoints('h', { memberName: 'Stranger' })).toContain('could not find');
  });
  it('does not guess between matching names or look outside the selected home', async () => {
    vi.mocked(api).mockResolvedValueOnce(user()).mockResolvedValueOnce([...members, { ...members[0], id: 'other' }]).mockResolvedValueOnce(points);
    expect(await readPoints('h', { memberName: 'mary' })).toContain('More than one');
    await expect(readPoints('other')).rejects.toThrow('cannot access');
  });
  it('reads only unread feed items, includes body, and never marks them read', async () => {
    const feed = [notification('Unread'), notification('Read private', { readAt: new Date().toISOString() })];
    expect(notificationReading(feed)).toBe('1 unread notification. Unread. Details.');
    vi.mocked(api).mockResolvedValueOnce(device()).mockResolvedValueOnce([...feed, notification('Personal secret', { memberId: 'm' }), notification('Other home', { householdId: 'other' })]);
    const result = await readNotifications('h');
    expect(result).toBe('1 unread notification. Unread. Details.');
    expect(api).toHaveBeenLastCalledWith('/api/v1/households/h/notifications');
    expect(deviceNotifications(feed, 'other')).toEqual([]);
  });
  it('filters expired announcements and reads pin/urgency rather than inactive history', () => {
    const items = [announcement('Normal'), announcement('Expired', { expiresAt: '2000-01-01T00:00:00Z' }), announcement('Urgent', { priority: 'URGENT', body: 'Now' }), announcement('Pinned', { pinned: true })];
    expect(activeAnnouncements(items).map((a) => a.title)).toEqual(['Pinned', 'Urgent', 'Normal']);
    expect(announcementReading(items)).toContain('3 active announcements. Pinned. Pinned. Urgent. Urgent. Now. Normal.');
    expect(announcementReading([])).toContain('no active');
  });
  it('uses actual TASK status, not chore completions, for pending tasks', () => {
    const tasks = [{ kind: 'TASK', title: 'Call plumber', status: 'OPEN', isOverdue: true }, { kind: 'TASK', title: 'Done', status: 'DONE' }, { kind: 'CHORE', title: 'Chore', status: 'OPEN' }] as Task[];
    expect(pendingTasksReading(tasks)).toBe('1 pending task. Call plumber, overdue.');
    expect(pendingTasksReading([])).toContain('no pending');
  });
});
