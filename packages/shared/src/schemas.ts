import { z } from 'zod';
import {
  ANNOUNCEMENT_PRIORITIES,
  CALENDAR_CATEGORIES,
  CALENDAR_VISIBILITIES,
  DASHBOARD_PRESETS,
  LIST_TYPES,
  MEMBER_ROLES,
  SHARE_ACCESS,
  SYNC_MODES,
  TASK_KINDS,
  TASK_PRIORITIES,
  WIDGET_TYPES,
} from './enums';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #4f46e5');
const isoDateTime = z.string().datetime({ offset: true });
const timezone = z.string().min(1).max(64).refine(isValidTimeZone, 'Unknown IANA timezone');

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── Auth ──
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  displayName: z.string().trim().min(1).max(80),
});
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});
export const passwordResetRequestSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const passwordResetConfirmSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(10).max(200),
});
export const devicePairSchema = z.object({ code: z.string().trim().toUpperCase().min(6).max(12) });

// ── Households ──
export const createHouseholdSchema = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: timezone.default('UTC'),
  ownerFirstName: z.string().trim().min(1).max(40).optional(),
  ownerColor: hexColor.optional(),
});
export const householdSettingsSchema = z.object({
  weatherLocation: z
    .object({ name: z.string().max(120), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .nullable()
    .optional(),
  temperatureUnit: z.enum(['celsius', 'fahrenheit']).optional(),
  clockFormat: z.enum(['12h', '24h']).optional(),
  screensaverMinutes: z.number().int().min(0).max(240).optional(),
  nightMode: z
    .object({ enabled: z.boolean(), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
    .optional(),
});
export const updateHouseholdSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: timezone.optional(),
  locale: z.string().min(2).max(20).optional(),
  weekStartsOn: z.number().int().min(0).max(6).optional(),
  settings: householdSettingsSchema.optional(),
});
export const setPinSchema = z.object({ pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits') });
export const verifyPinSchema = z.object({ pin: z.string().regex(/^\d{4,8}$/) });

// ── Members ──
export const createMemberSchema = z.object({
  firstName: z.string().trim().min(1).max(40),
  displayName: z.string().trim().min(1).max(40).optional(),
  role: z.enum(MEMBER_ROLES),
  color: hexColor.optional(),
  birthDate: z.string().date().nullable().optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
  accessExpiresAt: isoDateTime.nullable().optional(),
  emergencyContact: z
    .object({ name: z.string().max(80), phone: z.string().max(40), relation: z.string().max(40).optional() })
    .nullable()
    .optional(),
});
export const updateMemberSchema = createMemberSchema.partial().extend({
  preferences: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});
export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(MEMBER_ROLES),
  memberId: z.string().uuid().optional(),
});
export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(200) });
const sixDigits = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');
export const verifyCodeSchema = z.object({ code: sixDigits });
export const approveJoinSchema = z.object({ code: sixDigits.optional() });

// ── Devices ──
export const createDeviceSchema = z.object({ name: z.string().trim().min(1).max(60) });

// ── Calendars ──
export const createCalendarSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  color: hexColor.optional(),
  category: z.enum(CALENDAR_CATEGORIES).default('FAMILY'),
  visibility: z.enum(CALENDAR_VISIBILITIES).default('HOUSEHOLD'),
  showOnWallDisplay: z.boolean().default(true),
  ownerMemberId: z.string().uuid().nullable().optional(),
  shares: z.array(z.object({ memberId: z.string().uuid(), access: z.enum(SHARE_ACCESS) })).max(50).optional(),
});
export const updateCalendarSchema = createCalendarSchema
  .partial()
  .extend({ syncMode: z.enum(SYNC_MODES).optional(), refreshIntervalMinutes: z.number().int().min(15).max(1440).optional() });

export const icsSubscribeSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  name: z.string().trim().min(1).max(80),
  color: hexColor.optional(),
  category: z.enum(CALENDAR_CATEGORIES).default('OTHER'),
  visibility: z.enum(CALENDAR_VISIBILITIES).default('HOUSEHOLD'),
  showOnWallDisplay: z.boolean().default(true),
  ownerMemberId: z.string().uuid().nullable().optional(),
  refreshIntervalMinutes: z.number().int().min(15).max(1440).default(360),
});

export const connectExternalCalendarsSchema = z.object({
  accountId: z.string().uuid(),
  calendars: z
    .array(
      z.object({
        externalCalendarId: z.string().min(1).max(500),
        name: z.string().trim().min(1).max(80),
        color: hexColor.optional(),
        category: z.enum(CALENDAR_CATEGORIES).default('PERSONAL'),
        visibility: z.enum(CALENDAR_VISIBILITIES).default('HOUSEHOLD'),
        showOnWallDisplay: z.boolean().default(true),
        syncMode: z.enum(SYNC_MODES).default('READ_ONLY'),
        ownerMemberId: z.string().uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
});

// ── Events ──
export const rruleString = z
  .string()
  .max(500)
  .regex(/^(RRULE:)?FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Za-z0-9,+\-:T]+)*$/, 'Invalid RRULE');

export const eventBaseSchema = z.object({
  calendarId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  startAt: isoDateTime,
  endAt: isoDateTime,
  allDay: z.boolean().default(false),
  timezone: timezone.optional(),
  rrule: rruleString.nullable().optional(),
  isPrivate: z.boolean().default(false),
  category: z.string().max(40).nullable().optional(),
  color: hexColor.nullable().optional(),
  memberIds: z.array(z.string().uuid()).max(30).default([]),
  reminderMinutes: z.array(z.number().int().min(0).max(40320)).max(5).default([]),
});
export const createEventSchema = eventBaseSchema.refine((e) => new Date(e.endAt) >= new Date(e.startAt), {
  message: 'endAt must be after startAt',
  path: ['endAt'],
});
export const updateEventSchema = eventBaseSchema
  .partial()
  .extend({
    scope: z.enum(['this', 'following', 'all']).default('all'),
    occurrenceStart: isoDateTime.optional(),
    expectedVersion: z.number().int().optional(),
  })
  .refine((e) => !e.startAt || !e.endAt || new Date(e.endAt) >= new Date(e.startAt), {
    message: 'endAt must be after startAt',
    path: ['endAt'],
  });
export const deleteEventSchema = z.object({
  scope: z.enum(['this', 'following', 'all']).default('all'),
  occurrenceStart: isoDateTime.optional(),
});
export const eventRangeQuery = z.object({
  start: isoDateTime,
  end: isoDateTime,
  calendarIds: z.string().optional(),
  memberIds: z.string().optional(),
  q: z.string().max(100).optional(),
});

// ── Tasks / chores ──
export const checklistItem = z.object({ id: z.string().min(1).max(64), title: z.string().min(1).max(200), done: z.boolean() });
export const createTaskSchema = z.object({
  kind: z.enum(TASK_KINDS).default('TASK'),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(40).nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).default('MEDIUM'),
  dueAt: isoDateTime.nullable().optional(),
  rrule: rruleString.nullable().optional(),
  points: z.number().int().min(0).max(1000).default(0),
  requiresApproval: z.boolean().default(false),
  rotate: z.boolean().default(false),
  icon: z.string().max(40).nullable().optional(),
  checklist: z.array(checklistItem).max(50).default([]),
  memberIds: z.array(z.string().uuid()).max(20).default([]),
});
export const updateTaskSchema = createTaskSchema.partial().extend({ status: z.enum(['OPEN', 'DONE', 'ARCHIVED']).optional() });
export const completeTaskSchema = z.object({
  memberId: z.string().uuid(),
  /** YYYY-MM-DD occurrence date for recurring chores; defaults to today in household timezone. */
  occurrenceDate: z.string().date().optional(),
});
export const reviewSchema = z.object({ approve: z.boolean() });

// ── Rewards ──
export const createRewardSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  icon: z.string().max(40).nullable().optional(),
  cost: z.number().int().min(1).max(100000),
  isActive: z.boolean().default(true),
});
export const updateRewardSchema = createRewardSchema.partial();
export const redeemRewardSchema = z.object({ memberId: z.string().uuid() });
export const adjustPointsSchema = z.object({
  memberId: z.string().uuid(),
  points: z.number().int().min(-10000).max(10000).refine((n) => n !== 0, 'Must be non-zero'),
  note: z.string().max(200).optional(),
});

// ── Lists ──
export const createListSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(LIST_TYPES).default('CUSTOM'),
  icon: z.string().max(40).nullable().optional(),
  color: hexColor.nullable().optional(),
  isTemplate: z.boolean().default(false),
});
export const updateListSchema = createListSchema.partial();
export const listItemFields = z.object({
  name: z.string().trim().min(1).max(200),
  quantity: z.string().max(20).nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  category: z.string().max(40).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  priceEstimateCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  isDone: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
/** Clients generate item ids (UUID) so offline creates can be replayed idempotently. */
export const createListItemSchema = listItemFields.extend({ id: z.string().uuid() });
export const updateListItemSchema = listItemFields.partial().extend({ expectedVersion: z.number().int().optional() });

// ── Announcements ──
export const createAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(140),
  body: z.string().max(2000).nullable().optional(),
  priority: z.enum(ANNOUNCEMENT_PRIORITIES).default('NORMAL'),
  color: hexColor.nullable().optional(),
  pinned: z.boolean().default(false),
  expiresAt: isoDateTime.nullable().optional(),
});
export const updateAnnouncementSchema = createAnnouncementSchema.partial();

// ── Dashboard ──
export const widgetSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(WIDGET_TYPES),
  visible: z.boolean().default(true),
  size: z.enum(['sm', 'md', 'lg']).default('md'),
  config: z.record(z.unknown()).default({}),
});
export const upsertDashboardLayoutSchema = z.object({
  name: z.string().trim().min(1).max(60),
  preset: z.enum(DASHBOARD_PRESETS).default('FAMILY_OVERVIEW'),
  widgets: z.array(widgetSchema).max(30),
  isDefault: z.boolean().default(false),
  deviceId: z.string().uuid().nullable().optional(),
});

export const userPreferencesSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  highContrast: z.boolean().optional(),
  largeText: z.boolean().optional(),
  reducedMotion: z.boolean().optional(),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type Widget = z.infer<typeof widgetSchema>;
export type HouseholdSettings = z.infer<typeof householdSettingsSchema>;
