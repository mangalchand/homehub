import { z } from 'zod';

/** Repeat schedule shared by announcements and note reminders. */
export const WEEKDAY_PRESETS = { weekdays: [1, 2, 3, 4, 5], weekends: [6, 7] } as const;
export const MAX_TIMES_PER_DAY = 6;
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24-hour).');
const unique = <T>(items: T[]) => new Set(items).size === items.length;

export const scheduleFields = z.object({
  repeatDaily: z.boolean().default(false),
  /** ISO weekdays (1=Mon..7=Sun); empty means every day (unless monthDays is set). */
  repeatDays: z.array(z.number().int().min(1).max(7)).max(7).refine(unique, 'Choose each day once.').default([]),
  /** Days of month (1..31); empty means not monthly. Day 31 is skipped in shorter months. */
  monthDays: z.array(z.number().int().min(1).max(31)).max(31).refine(unique, 'Choose each date once.').default([]),
  /** Local times of day, at most MAX_TIMES_PER_DAY per day. */
  dailyTimes: z.array(timeOfDay).max(MAX_TIMES_PER_DAY, `At most ${MAX_TIMES_PER_DAY} times per day.`).refine(unique, 'Choose each time once.').default([]),
});
export type ScheduleInput = z.infer<typeof scheduleFields>;

export function scheduleIssues(value: ScheduleInput, ctx: z.RefinementCtx, legacyTime?: string | null) {
  const times = value.dailyTimes.length ? value.dailyTimes : legacyTime ? [legacyTime] : [];
  if (value.repeatDaily && !times.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dailyTimes'], message: 'Choose at least one time.' });
  if (!value.repeatDaily && (value.repeatDays.length || value.monthDays.length || value.dailyTimes.length))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repeatDays'], message: 'Turn on repeating to choose days.' });
  if (value.repeatDays.length && value.monthDays.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['monthDays'], message: 'Choose weekdays or dates of the month, not both.' });
}
export const scheduleSchema = scheduleFields.superRefine((v, ctx) => scheduleIssues(v, ctx));

export interface LocalClock { isoDate: string; weekday: number; day: number; hour: number; minute: number }
export const slotFor = (isoDate: string, time: string) => `${isoDate}T${time}`;
const sortedTimes = (s: Pick<ScheduleInput, 'dailyTimes'>, legacyTime?: string | null) => [...(s.dailyTimes.length ? s.dailyTimes : legacyTime ? [legacyTime] : [])].sort();

/** True when the schedule fires on this local date. */
export function runsOnDate(s: Pick<ScheduleInput, 'repeatDays' | 'monthDays'>, clock: Pick<LocalClock, 'weekday' | 'day'>) {
  if (s.monthDays.length) return s.monthDays.includes(clock.day);
  if (s.repeatDays.length) return s.repeatDays.includes(clock.weekday);
  return true;
}

/** Latest slot (`YYYY-MM-DDTHH:mm`) due now that is newer than `lastSlot`, or null. Slots compare lexicographically. */
export function dueSlot(s: Pick<ScheduleInput, 'repeatDays' | 'monthDays' | 'dailyTimes'>, clock: LocalClock, lastSlot: string | null | undefined, legacyTime?: string | null) {
  if (!runsOnDate(s, clock)) return null;
  const nowMinutes = clock.hour * 60 + clock.minute;
  let due: string | null = null;
  for (const time of sortedTimes(s, legacyTime)) {
    const [h, m] = time.split(':').map(Number);
    if (h! * 60 + m! > nowMinutes) break;
    due = slotFor(clock.isoDate, time);
  }
  if (!due || (lastSlot && due <= lastSlot)) return null;
  return due;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function describeSchedule(s: Pick<ScheduleInput, 'repeatDaily' | 'repeatDays' | 'monthDays' | 'dailyTimes'>, legacyTime?: string | null) {
  if (!s.repeatDaily) return 'Does not repeat';
  const times = sortedTimes(s, legacyTime).join(', ');
  const days = [...s.repeatDays].sort().join(',');
  const when = s.monthDays.length
    ? `monthly on day ${[...s.monthDays].sort((a, b) => a - b).join(', ')}`
    : days === '1,2,3,4,5' ? 'weekdays' : days === '6,7' ? 'weekends' : s.repeatDays.length === 1 ? `every ${DAY_NAMES[s.repeatDays[0]! - 1]}` : s.repeatDays.length && s.repeatDays.length < 7 ? `every ${[...s.repeatDays].sort().map((d) => DAY_NAMES[d - 1]).join(', ')}` : 'every day';
  return `${when[0]!.toUpperCase()}${when.slice(1)} at ${times}`;
}
