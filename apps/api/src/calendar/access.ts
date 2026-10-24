import type { Calendar, CalendarConnection, CalendarShare } from '@prisma/client';
import type { Actor, CalendarAccess } from '@familyhub/shared';

export type CalendarWithAccess = Calendar & { shares: CalendarShare[]; connection: CalendarConnection | null };

const RANK: Record<CalendarAccess, number> = { NONE: 0, BUSY: 1, READ: 2, WRITE: 3 };
const min = (a: CalendarAccess, b: CalendarAccess) => (RANK[a] <= RANK[b] ? a : b);

/** Why a calendar cannot be written at all (independent of viewer). */
export function readOnlyReason(cal: CalendarWithAccess): string | null {
  if (cal.source === 'ICS_URL') return 'ICS subscriptions are read-only. Edit the event at its source.';
  if (cal.source === 'ICS_FILE') return 'Imported file calendars are read-only.';
  if (cal.source === 'ICLOUD_CALDAV') return 'iCloud calendars are read-only in this version.';
  if (cal.isReadOnly) return 'The provider reports this calendar as read-only.';
  if ((cal.source === 'GOOGLE' || cal.source === 'MICROSOFT') && cal.connection?.syncMode !== 'TWO_WAY') {
    return 'This calendar is connected in read-only mode.';
  }
  return null;
}

/**
 * Effective access of `actor` to a calendar. This is the single source of truth for calendar privacy and is
 * applied to every API response — the frontend never receives data the viewer is not allowed to see.
 */
export function calendarAccess(actor: Actor, cal: CalendarWithAccess): CalendarAccess {
  if (cal.deletedAt) return 'NONE';
  const cap: CalendarAccess = readOnlyReason(cal) ? 'READ' : 'WRITE';

  if (actor.kind === 'device') {
    if (!cal.showOnWallDisplay) return 'NONE';
    if (cal.visibility === 'PRIVATE' || cal.visibility === 'SELECTED') return 'NONE';
    if (cal.visibility === 'BUSY_ONLY') return 'BUSY';
    return actor.elevated && cal.source === 'INTERNAL' ? min('WRITE', cap) : 'READ';
  }

  if (cal.ownerMemberId && cal.ownerMemberId === actor.memberId) return cap;

  switch (cal.visibility) {
    case 'PRIVATE':
      return 'NONE';
    case 'BUSY_ONLY':
      return 'BUSY';
    case 'SELECTED': {
      const share = cal.shares.find((s) => s.memberId === actor.memberId);
      if (!share) return 'NONE';
      const granted: CalendarAccess = share.access;
      return min(granted, actor.role === 'GUEST' || actor.role === 'CHILD' ? 'READ' : cap);
    }
    case 'HOUSEHOLD':
    default:
      if (actor.role === 'CHILD' || actor.role === 'GUEST') return 'READ';
      return cap;
  }
}

export interface EventPrivacyInput {
  isPrivate: boolean;
  createdById: string | null;
}

/** Per-event view: private events are shown as busy blocks to everyone except the calendar owner/creator. */
export function eventView(actor: Actor, cal: CalendarWithAccess, access: CalendarAccess, ev: EventPrivacyInput) {
  if (access === 'NONE') return { visible: false, busyOnly: true, canEdit: false };
  const isOwner = actor.kind === 'member' && (cal.ownerMemberId === actor.memberId || ev.createdById === actor.userId);
  const busyOnly = access === 'BUSY' || (ev.isPrivate && !isOwner);
  return { visible: true, busyOnly, canEdit: access === 'WRITE' && !busyOnly };
}
