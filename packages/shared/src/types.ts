import type { CalendarAccess, CalendarCategory, CalendarSource, CalendarVisibility, MemberRole } from './enums';

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface MemberDTO {
  id: string;
  firstName: string;
  displayName: string;
  role: MemberRole;
  color: string;
  avatarUrl: string | null;
  birthDate: string | null;
  hasLogin: boolean;
  isActive: boolean;
  accessExpiresAt: string | null;
  emergencyContact?: unknown;
}

export interface CalendarDTO {
  id: string;
  name: string;
  description: string | null;
  color: string;
  category: CalendarCategory;
  source: CalendarSource;
  visibility: CalendarVisibility;
  showOnWallDisplay: boolean;
  ownerMemberId: string | null;
  access: CalendarAccess;
  readOnlyReason: string | null;
  sync?: {
    connectionId: string;
    syncMode: 'READ_ONLY' | 'TWO_WAY';
    status: 'IDLE' | 'RUNNING' | 'ERROR';
    lastSuccessAt: string | null;
    lastError: string | null;
    nextSyncAt: string | null;
    accountStatus: string | null;
    refreshIntervalMinutes?: number;
    enabled?: boolean;
  };
}

export interface EventOccurrenceDTO {
  /** Stable occurrence id: eventId for single events, `${eventId}::${originalStartISO}` for recurrences. */
  id: string;
  eventId: string;
  calendarId: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  isRecurring: boolean;
  rrule: string | null;
  originalStartAt: string | null;
  isPrivate: boolean;
  /** True when the viewer only sees a busy block. */
  busyOnly: boolean;
  color: string;
  category: string | null;
  memberIds: string[];
  canEdit: boolean;
  syncState: string;
  syncError: string | null;
  version: number;
  conflictsWith: string[];
}
