import { DateTime } from 'luxon';

export function todayInZone(tz: string): string {
  return DateTime.now().setZone(tz).toISODate()!;
}

export function startOfDayInZone(date: string, tz: string): Date {
  return DateTime.fromISO(date, { zone: tz }).startOf('day').toJSDate();
}

export function addDays(d: Date, days: number) {
  return new Date(d.getTime() + days * 86400000);
}
