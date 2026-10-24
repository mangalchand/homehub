import { describe, expect, it } from 'vitest';
import { IcsParseError, parseIcs } from '../../src/calendar/ics.js';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:Eastern Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly-1@test
SUMMARY:Swim class
DTSTART;TZID=Eastern Standard Time:20261027T170000
DTEND;TZID=Eastern Standard Time:20261027T180000
RRULE:FREQ=WEEKLY;BYDAY=TU
EXDATE;TZID=Eastern Standard Time:20261103T170000
LOCATION:YMCA
END:VEVENT
BEGIN:VEVENT
UID:allday-1@test
SUMMARY:Teacher planning day
DTSTART;VALUE=DATE:20261106
DTEND;VALUE=DATE:20261107
CLASS:PRIVATE
END:VEVENT
END:VCALENDAR`;

describe('ICS parser', () => {
  it('parses recurring, timezone-aware and all-day events', () => {
    const events = parseIcs(ICS, 'UTC');
    expect(events).toHaveLength(2);
    const swim = events.find((e) => e.title === 'Swim class')!;
    expect(swim.startAt.toISOString()).toBe('2026-10-27T21:00:00.000Z');
    expect(swim.timezone).toBe('America/New_York');
    expect(swim.rrule).toContain('FREQ=WEEKLY');
    expect(swim.exdates).toHaveLength(1);
    const allDay = events.find((e) => e.title === 'Teacher planning day')!;
    expect(allDay.allDay).toBe(true);
    expect(allDay.isPrivate).toBe(true);
  });

  it('rejects input that is not a calendar', () => {
    expect(() => parseIcs('<html>nope</html>', 'UTC')).toThrow(IcsParseError);
  });
});
