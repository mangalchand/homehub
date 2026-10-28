import { can, MEMBER_ROLES, type Actor, type MemberDTO, type MemberRole } from '@familyhub/shared';
import type { Announcement, Me, Points, Task } from '../queries';
import type { AppNotification } from '../notifications';
import { api, hh, ApiRequestError } from '../api';

export function householdActor(me: Me | undefined, hid: string): Actor | null {
  if (!me) return null;
  if (me.kind === 'device') {
    if (!me.device || me.device.householdId !== hid) return null;
    return { kind: 'device', deviceId: me.device.id, elevated: Boolean(me.session.pinElevatedUntil && new Date(me.session.pinElevatedUntil).getTime() > Date.now()) };
  }
  const m = me.memberships.find((x) => x.householdId === hid);
  if (!m?.memberId || !me.user || !MEMBER_ROLES.includes(m.role as MemberRole)) return null;
  return { kind: 'member', memberId: m.memberId, userId: me.user.id, role: m.role as MemberRole };
}

export function canAnnounce(me: Me | undefined, hid: string) {
  const actor = householdActor(me, hid);
  return Boolean(actor && can(actor, 'announcements.write'));
}

export function voiceScope(me: Me | undefined, hid: string) {
  const actor = householdActor(me, hid);
  return actor ? `${hid}:${actor.kind}:${actor.kind === 'device' ? actor.deviceId : `${actor.userId}:${actor.memberId}`}` : null;
}

export function voiceError(error: unknown, device = false) {
  if (error instanceof ApiRequestError && error.status === 403) {
    return device ? 'This action needs permission. Unlock parent mode with the household PIN, then try again.' : 'You do not have permission for this action in this home.';
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

const join = (items: string[]) => items.join('. ');
const remaining = (count: number, limit: number) => count > limit ? `. And ${count - limit} more` : '';

export function activeAnnouncements(items: Announcement[], now = Date.now()) {
  const priority = { URGENT: 2, IMPORTANT: 1, NORMAL: 0 };
  return items.filter((a) => !a.expiresAt || Date.parse(a.expiresAt) > now).sort((a, b) => Number(b.pinned) - Number(a.pinned) || priority[b.priority] - priority[a.priority] || b.createdAt.localeCompare(a.createdAt));
}

export function announcementReading(items: Announcement[]) {
  const active = activeAnnouncements(items);
  if (!active.length) return 'There are no active announcements.';
  return `${active.length} active ${active.length === 1 ? 'announcement' : 'announcements'}. ${join(active.slice(0, 5).map((a) => `${a.priority === 'URGENT' ? 'Urgent. ' : ''}${a.pinned ? 'Pinned. ' : ''}${a.title}${a.body ? `. ${a.body}` : ''}`))}${remaining(active.length, 5)}.`;
}

export function notificationReading(items: AppNotification[]) {
  const unread = items.filter((n) => !n.readAt);
  if (!unread.length) return 'There are no unread notifications.';
  return `${unread.length} unread ${unread.length === 1 ? 'notification' : 'notifications'}. ${join(unread.slice(0, 5).map((n) => `${n.title}${n.body ? `. ${n.body}` : ''}`))}${remaining(unread.length, 5)}.`;
}

export function pointsReading(members: MemberDTO[], points: Points[], memberId: string) {
  const member = members.find((m) => m.id === memberId && m.isActive);
  if (!member) return 'I could not find that active member in this home.';
  const p = points.find((x) => x.memberId === memberId);
  if (!p) return `Points for ${member.displayName} are unavailable. Please try again.`;
  const reserved = Math.max(0, p.balance - p.available);
  // pending includes negative redemption requests as well as positive earnings.
  const awaiting = Math.max(0, p.pending + reserved);
  return `${member.displayName} has ${p.available} points available, from a balance of ${p.balance}.${reserved ? ` ${reserved} points are reserved for reward requests.` : ''}${awaiting ? ` ${awaiting} earned points are awaiting approval.` : ''}`;
}

export function pendingTasksReading(tasks: Task[]) {
  const open = tasks.filter((t) => t.kind === 'TASK' && t.status !== 'DONE');
  if (!open.length) return 'There are no pending tasks.';
  return `${open.length} pending ${open.length === 1 ? 'task' : 'tasks'}. ${join(open.slice(0, 8).map((t) => `${t.title}${t.isOverdue ? ', overdue' : ''}`))}${remaining(open.length, 8)}.`;
}

/** Fetch the session before the feed: a shared display must only use its fixed-home device session. */
export async function currentVoiceSession(hid: string) {
  const me = await api<Me>('/api/v1/auth/me');
  if (!householdActor(me, hid)) throw new Error('This session cannot access that home. Refresh and try again.');
  return me;
}

export async function readNotifications(hid: string) {
  const me = await currentVoiceSession(hid);
  const items = await api<FeedNotification[]>(hh(hid, '/notifications'));
  return notificationReading(me.kind === 'device' ? deviceNotifications(items, hid) : items);
}

export type FeedNotification = AppNotification & { householdId: string; memberId: string | null };
export const deviceNotifications = (items: FeedNotification[], hid: string) => items.filter((n) => n.householdId === hid && n.memberId === null);

export async function readPoints(hid: string, options: { memberId?: string; memberName?: string } = {}) {
  const me = await currentVoiceSession(hid);
  const actor = householdActor(me, hid)!;
  if (!options.memberId && !options.memberName && actor.kind === 'device') return 'This is a shared home display. Ask how many points a named member has.';
  const [members, points] = await Promise.all([api<MemberDTO[]>(hh(hid, '/members')), api<Points[]>(hh(hid, '/points'))]);
  let memberId = options.memberId ?? (actor.kind === 'member' ? actor.memberId : undefined);
  if (options.memberName) {
    const name = options.memberName.toLowerCase();
    const matches = members.filter((m) => m.isActive && (m.displayName.toLowerCase() === name || m.firstName.toLowerCase() === name));
    if (matches.length !== 1) return matches.length ? 'More than one member matches. Please use their full display name.' : `I could not find ${options.memberName} in this home.`;
    memberId = matches[0]!.id;
  }
  return pointsReading(members, points, memberId!);
}
