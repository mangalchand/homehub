import { DateTime } from 'luxon';

/** Returns a Date whose *local* fields equal the wall-clock time in `tz` (for date-fns formatting/grouping). */
export function zoned(d: Date | string, tz: string): Date {
  const z = DateTime.fromJSDate(typeof d === 'string' ? new Date(d) : d).setZone(tz);
  return new Date(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
}

/** Formats an instant as a datetime-local / date input value in `tz`. */
export function toTzInput(d: Date, tz: string, allDay: boolean): string {
  return DateTime.fromJSDate(d).setZone(tz).toFormat(allDay ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm");
}

/** Parses a datetime-local value as wall-clock time in `tz`. */
export function fromTzInput(v: string, tz: string): Date {
  return DateTime.fromISO(v, { zone: tz }).toJSDate();
}
