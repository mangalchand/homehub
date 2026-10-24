export const MEMBER_ROLES = ['OWNER', 'ADULT_ADMIN', 'ADULT', 'CHILD', 'GUEST'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const CALENDAR_CATEGORIES = ['FAMILY', 'PERSONAL', 'WORK', 'SCHOOL', 'HOLIDAYS', 'BIRTHDAYS', 'OTHER'] as const;
export type CalendarCategory = (typeof CALENDAR_CATEGORIES)[number];

export const CALENDAR_VISIBILITIES = ['HOUSEHOLD', 'PRIVATE', 'BUSY_ONLY', 'SELECTED'] as const;
export type CalendarVisibility = (typeof CALENDAR_VISIBILITIES)[number];

export const CALENDAR_SOURCES = ['INTERNAL', 'GOOGLE', 'MICROSOFT', 'ICLOUD_CALDAV', 'ICS_URL', 'ICS_FILE'] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

export const SHARE_ACCESS = ['BUSY', 'READ', 'WRITE'] as const;
export type ShareAccess = (typeof SHARE_ACCESS)[number];

export const SYNC_MODES = ['READ_ONLY', 'TWO_WAY'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const TASK_KINDS = ['TASK', 'CHORE'] as const;
export const LIST_TYPES = ['GROCERY', 'HOUSEHOLD', 'SCHOOL', 'PACKING', 'WISHLIST', 'TODO', 'CUSTOM'] as const;
export const ANNOUNCEMENT_PRIORITIES = ['NORMAL', 'IMPORTANT', 'URGENT'] as const;

export const DASHBOARD_PRESETS = [
  'CALENDAR_FOCUS',
  'FAMILY_OVERVIEW',
  'KIDS',
  'DAILY_PLANNER',
  'PHOTO_FRAME',
  'CUSTOM',
] as const;
export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number];

export const WIDGET_TYPES = [
  'calendar',
  'agenda',
  'tasks',
  'chores',
  'lists',
  'announcements',
  'birthdays',
  'weather',
  'clock',
  'rewards',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Effective access a viewer has to a calendar after privacy rules are applied. */
export type CalendarAccess = 'NONE' | 'BUSY' | 'READ' | 'WRITE';
