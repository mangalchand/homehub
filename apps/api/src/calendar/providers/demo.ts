import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import type { CalendarProvider, OutgoingEvent, RemoteCalendar, RemoteEvent, SyncContext, SyncResult } from './types.js';

/**
 * Development-only provider that simulates an external account (two calendars + a flaky one) so the import
 * wizard, two-way edits, sync errors and retries can be demonstrated without real OAuth credentials.
 * Remote state lives in memory and resets when the API restarts.
 */
const remote = new Map<string, Map<string, RemoteEvent>>();

function seedCalendar(id: string): Map<string, RemoteEvent> {
  const existing = remote.get(id);
  if (existing) return existing;
  const events = new Map<string, RemoteEvent>();
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  const at = (dayOffset: number, hourUtc: number) => new Date(monday.getTime() + dayOffset * 86400000 + hourUtc * 3600000);
  const add = (title: string, day: number, hour: number, hours: number, extra: Partial<RemoteEvent> = {}) => {
    const externalId = `${id}-${title.toLowerCase().replace(/\W+/g, '-')}`;
    events.set(externalId, {
      externalId, title, description: null, location: null, startAt: at(day, hour), endAt: at(day, hour + hours),
      allDay: false, timezone: 'UTC', rrule: null, exdates: [], status: 'CONFIRMED', isPrivate: false,
      updatedAt: new Date('2024-01-01T00:00:00Z'), etag: '1', ...extra,
    });
  };
  if (id === 'demo-work') {
    add('Team standup', 0, 14, 0.5, { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' });
    add('Quarterly planning', 2, 16, 2, { location: 'Conference room B' });
    add('1:1 with manager', 3, 18, 1, { isPrivate: true });
  } else if (id === 'demo-personal') {
    add('Gym', 1, 12, 1, { rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
    add('Dentist', 4, 15, 1, { location: '123 Main St' });
  } else if (id === 'demo-flaky') {
    add('Soccer practice', 2, 22, 1.5, { rrule: 'FREQ=WEEKLY;BYDAY=WE', location: 'Riverside Park' });
  }
  remote.set(id, events);
  return events;
}

export class DemoCalendarProvider implements CalendarProvider {
  type = 'GOOGLE' as const; // stored as a Google-like two-way account; flagged by externalAccountId prefix "demo:"
  capabilities = { oauth: false, twoWay: true, incremental: false, push: false };

  isConfigured() {
    return config.ENABLE_DEMO_PROVIDER;
  }

  async listCalendars(): Promise<RemoteCalendar[]> {
    return [
      { externalId: 'demo-work', name: 'Work (demo)', color: '#0ea5e9', readOnly: false, primary: true },
      { externalId: 'demo-personal', name: 'Personal (demo)', color: '#10b981', readOnly: false },
      { externalId: 'demo-flaky', name: 'Soccer club (demo, fails first sync)', color: '#f59e0b', readOnly: true },
      { externalId: 'demo-holidays', name: 'Holidays (demo, read-only)', color: '#ef4444', readOnly: true },
    ];
  }

  async initialSync(ctx: SyncContext): Promise<SyncResult> {
    const id = ctx.externalCalendarId!;
    if (id === 'demo-flaky' && !ctx.hasSucceededBefore && ctx.consecutiveFailures === 0) {
      throw new Error('Demo provider: simulated outage on first sync. Use "Retry sync" to recover.');
    }
    return { events: [...seedCalendar(id).values()], deletedExternalIds: [], fullSync: true, nextSyncToken: null };
  }

  incrementalSync(ctx: SyncContext) {
    return this.initialSync(ctx);
  }

  private toRemote(externalId: string, ev: OutgoingEvent, version: number): RemoteEvent {
    return { externalId, ...ev, exdates: [], status: 'CONFIRMED', updatedAt: new Date(), etag: String(version) };
  }

  async createEvent(ctx: SyncContext, ev: OutgoingEvent) {
    const r = this.toRemote(`demo-${randomUUID()}`, ev, 1);
    seedCalendar(ctx.externalCalendarId!).set(r.externalId, r);
    return r;
  }

  async updateEvent(ctx: SyncContext, externalId: string, ev: OutgoingEvent) {
    const cal = seedCalendar(ctx.externalCalendarId!);
    const prev = cal.get(externalId);
    const r = this.toRemote(externalId, ev, Number(prev?.etag ?? 0) + 1);
    cal.set(externalId, r);
    return r;
  }

  async deleteEvent(ctx: SyncContext, externalId: string) {
    seedCalendar(ctx.externalCalendarId!).delete(externalId);
  }

  /** Test helper: mutate the simulated remote calendar. */
  static remoteCalendar(id: string) {
    return seedCalendar(id);
  }
}
