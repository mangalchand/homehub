import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { AppError } from '../lib/errors.js';
import type { RemoteEvent } from './providers/types.js';
import { safeZone, stripRrulePrefix } from './recurrence.js';

const MAX_EVENTS = 20000;

export class IcsParseError extends AppError {
  constructor(message: string) {
    super(422, 'INVALID_ICS', message);
  }
}

/** Common Windows/Outlook timezone names seen in ICS exports. */
const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'India Standard Time': 'Asia/Kolkata',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  UTC: 'UTC',
};

function resolveZone(tzid: string | undefined | null, fallback: string): string {
  if (!tzid || tzid === 'floating') return fallback;
  if (tzid === 'Z' || tzid === 'UTC') return 'UTC';
  const mapped = WINDOWS_ZONES[tzid] ?? tzid;
  const z = safeZone(mapped);
  return z === 'UTC' && mapped !== 'UTC' ? fallback : z;
}

function timeToDate(t: ICAL.Time, zone: string): Date {
  if (t.isDate) return new Date(Date.UTC(t.year, t.month - 1, t.day));
  const tzid = (t as unknown as { timezone?: string }).timezone ?? t.zone?.tzid;
  if (!tzid || tzid === 'floating' || (t.zone && t.zone.tzid === 'floating')) {
    return DateTime.fromObject(
      { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
      { zone },
    ).toJSDate();
  }
  // Prefer IANA resolution in luxon; fall back to ical.js VTIMEZONE conversion.
  const ianaOk = DateTime.now().setZone(WINDOWS_ZONES[tzid] ?? tzid).isValid;
  if (ianaOk || tzid === 'Z' || tzid === 'UTC') {
    return DateTime.fromObject(
      { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
      { zone: tzid === 'Z' ? 'UTC' : (WINDOWS_ZONES[tzid] ?? tzid) },
    ).toJSDate();
  }
  return t.toJSDate();
}

/** Parse and validate iCalendar text into normalized events (VEVENT only). */
export function parseIcs(text: string, fallbackTimezone: string): RemoteEvent[] {
  if (!text || !/BEGIN:VCALENDAR/i.test(text)) throw new IcsParseError('This does not look like an iCalendar (.ics) file');
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch (e) {
    throw new IcsParseError(`Could not parse calendar: ${(e as Error).message}`);
  }
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(vtz);
    } catch {
      /* ignore malformed timezone definitions */
    }
  }
  const calZone = resolveZone(root.getFirstPropertyValue('x-wr-timezone') as string | null, fallbackTimezone);
  const vevents = root.getAllSubcomponents('vevent');
  if (vevents.length > MAX_EVENTS) throw new IcsParseError(`Calendar has too many events (max ${MAX_EVENTS})`);

  const out: RemoteEvent[] = [];
  for (const ve of vevents) {
    const ev = new ICAL.Event(ve);
    if (!ev.startDate) continue;
    const uid = ev.uid || `${ev.summary}-${ev.startDate.toString()}`;
    const zone = resolveZone((ev.startDate as unknown as { timezone?: string }).timezone ?? ev.startDate.zone?.tzid, calZone);
    const allDay = ev.startDate.isDate;
    const startAt = timeToDate(ev.startDate, zone);
    let endAt: Date;
    if (ev.endDate) endAt = timeToDate(ev.endDate, zone);
    else endAt = allDay ? new Date(startAt.getTime() + 86400000) : startAt;
    if (endAt < startAt) endAt = startAt;

    const rruleProp = ve.getFirstPropertyValue('rrule') as ICAL.Recur | null;
    const exdates: Date[] = [];
    for (const prop of ve.getAllProperties('exdate')) {
      for (const v of prop.getValues() as ICAL.Time[]) exdates.push(timeToDate(v, zone));
    }
    const statusRaw = String(ve.getFirstPropertyValue('status') ?? 'CONFIRMED').toUpperCase();
    const klass = String(ve.getFirstPropertyValue('class') ?? 'PUBLIC').toUpperCase();
    const lm = (ve.getFirstPropertyValue('last-modified') ?? ve.getFirstPropertyValue('dtstamp')) as ICAL.Time | null;
    const recurrenceId = ev.recurrenceId;

    out.push({
      externalId: recurrenceId ? `${uid}::${timeToDate(recurrenceId, zone).toISOString()}` : uid,
      iCalUid: uid,
      title: (ev.summary || '(No title)').slice(0, 200),
      description: ev.description ? String(ev.description).slice(0, 5000) : null,
      location: ev.location ? String(ev.location).slice(0, 500) : null,
      startAt,
      endAt,
      allDay,
      timezone: allDay ? 'UTC' : zone,
      rrule: rruleProp && !recurrenceId ? stripRrulePrefix(rruleProp.toString()) : null,
      exdates,
      recurringExternalId: recurrenceId ? uid : null,
      originalStartAt: recurrenceId ? timeToDate(recurrenceId, zone) : null,
      status: statusRaw === 'CANCELLED' ? 'CANCELLED' : statusRaw === 'TENTATIVE' ? 'TENTATIVE' : 'CONFIRMED',
      isPrivate: klass === 'PRIVATE' || klass === 'CONFIDENTIAL',
      updatedAt: lm ? lm.toJSDate() : null,
      etag: null,
    });
  }
  return out;
}
