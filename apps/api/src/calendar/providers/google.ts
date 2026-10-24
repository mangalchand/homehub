import { config, providerConfigured } from '../../config.js';
import {
  checkResponse,
  type CalendarProvider,
  type FetchLike,
  type OutgoingEvent,
  type RemoteCalendar,
  type RemoteEvent,
  type SyncContext,
  type SyncResult,
} from './types.js';

const API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar'];

interface GEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GEventTime;
  end?: GEventTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GEventTime;
  updated?: string;
  etag?: string;
  iCalUID?: string;
  visibility?: string;
}

function parseTime(t: GEventTime | undefined, fallbackTz: string): { at: Date; allDay: boolean; tz: string } {
  if (!t) return { at: new Date(0), allDay: false, tz: fallbackTz };
  if (t.date) return { at: new Date(`${t.date}T00:00:00Z`), allDay: true, tz: 'UTC' };
  return { at: new Date(t.dateTime!), allDay: false, tz: t.timeZone ?? fallbackTz };
}

/** Map a Google Calendar event resource to the normalized model. Exported for unit tests. */
export function mapGoogleEvent(g: GEvent, fallbackTz: string): RemoteEvent {
  const start = parseTime(g.start, fallbackTz);
  const end = parseTime(g.end, fallbackTz);
  const rruleLine = g.recurrence?.find((r) => r.startsWith('RRULE:'));
  const exdates: Date[] = [];
  for (const line of g.recurrence ?? []) {
    if (!line.startsWith('EXDATE')) continue;
    const values = line.split(':')[1]?.split(',') ?? [];
    for (const v of values) {
      const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
      if (!m) continue;
      exdates.push(
        m[4]
          ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!))
          : new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)),
      );
    }
  }
  return {
    externalId: g.id,
    iCalUid: g.iCalUID ?? null,
    title: g.summary ?? '(No title)',
    description: g.description ?? null,
    location: g.location ?? null,
    startAt: start.at,
    endAt: end.at,
    allDay: start.allDay,
    timezone: start.tz,
    rrule: rruleLine ? rruleLine.slice('RRULE:'.length) : null,
    exdates,
    recurringExternalId: g.recurringEventId ?? null,
    originalStartAt: g.originalStartTime ? parseTime(g.originalStartTime, fallbackTz).at : null,
    status: g.status === 'cancelled' ? 'CANCELLED' : g.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED',
    isPrivate: g.visibility === 'private' || g.visibility === 'confidential',
    updatedAt: g.updated ? new Date(g.updated) : null,
    etag: g.etag ?? null,
  };
}

export function toGoogleBody(ev: OutgoingEvent) {
  const time = (d: Date) =>
    ev.allDay ? { date: d.toISOString().slice(0, 10) } : { dateTime: d.toISOString(), timeZone: ev.timezone };
  return {
    summary: ev.title,
    description: ev.description ?? undefined,
    location: ev.location ?? undefined,
    start: time(ev.startAt),
    end: time(ev.endAt),
    recurrence: ev.rrule ? [`RRULE:${ev.rrule}`] : undefined,
    visibility: ev.isPrivate ? 'private' : 'default',
  };
}

export class GoogleCalendarProvider implements CalendarProvider {
  type = 'GOOGLE' as const;
  capabilities = { oauth: true, twoWay: true, incremental: true, push: true };
  constructor(private http: FetchLike = fetch) {}

  isConfigured() {
    return providerConfigured.google();
  }

  private redirectUri() {
    return `${config.API_PUBLIC_URL}/api/v1/integrations/google/callback`;
  }

  buildAuthorizationUrl(state: string, codeChallenge: string) {
    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchangeCode(code: string, codeVerifier: string) {
    const res = await checkResponse(
      await this.http('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.GOOGLE_CLIENT_ID,
          client_secret: config.GOOGLE_CLIENT_SECRET,
          redirect_uri: this.redirectUri(),
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
      }),
      'Google',
    );
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
    const info = (await (
      await checkResponse(
        await this.http('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } }),
        'Google',
      )
    ).json()) as { sub: string; email?: string; name?: string };
    return {
      tokens: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token ?? null,
        expiresAt: new Date(Date.now() + t.expires_in * 1000),
        scopes: t.scope.split(' '),
      },
      account: { externalAccountId: info.sub, email: info.email ?? null, displayName: info.name ?? info.email ?? null },
    };
  }

  async refreshAuthorization(refreshToken: string) {
    const res = await checkResponse(
      await this.http('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.GOOGLE_CLIENT_ID,
          client_secret: config.GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      }),
      'Google',
    );
    const t = (await res.json()) as { access_token: string; expires_in: number };
    return { accessToken: t.access_token, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
  }

  async disconnect(tokens: { accessToken: string | null; refreshToken: string | null }) {
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return;
    await this.http(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined);
  }

  async listCalendars(accessToken: string | null): Promise<RemoteCalendar[]> {
    const res = await checkResponse(
      await this.http(`${API}/users/me/calendarList?minAccessRole=freeBusyReader`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      'Google',
    );
    const data = (await res.json()) as {
      items: { id: string; summary: string; backgroundColor?: string; accessRole: string; primary?: boolean; timeZone?: string }[];
    };
    return data.items.map((c) => ({
      externalId: c.id,
      name: c.summary,
      color: c.backgroundColor ?? null,
      readOnly: !['owner', 'writer'].includes(c.accessRole),
      primary: Boolean(c.primary),
      timezone: c.timeZone ?? null,
    }));
  }

  private async listEvents(ctx: SyncContext, params: Record<string, string>): Promise<SyncResult> {
    const events: RemoteEvent[] = [];
    const deleted: string[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    do {
      const qs = new URLSearchParams({ ...params, maxResults: '2500', showDeleted: 'true', singleEvents: 'false' });
      if (pageToken) qs.set('pageToken', pageToken);
      const res = await checkResponse(
        await this.http(`${API}/calendars/${encodeURIComponent(ctx.externalCalendarId!)}/events?${qs}`, {
          headers: { Authorization: `Bearer ${ctx.accessToken}` },
        }),
        'Google',
      );
      const page = (await res.json()) as { items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string };
      for (const item of page.items ?? []) {
        // Cancelled instances of a recurring series are exceptions, not deletions of the series.
        if (item.status === 'cancelled' && !item.recurringEventId) deleted.push(item.id);
        else events.push(mapGoogleEvent(item, ctx.fallbackTimezone));
      }
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
    return { events, deletedExternalIds: deleted, fullSync: !params.syncToken, nextSyncToken };
  }

  initialSync(ctx: SyncContext) {
    const timeMin = new Date(Date.now() - 180 * 86400000).toISOString();
    return this.listEvents(ctx, { timeMin });
  }

  incrementalSync(ctx: SyncContext) {
    if (!ctx.syncToken) return this.initialSync(ctx);
    return this.listEvents(ctx, { syncToken: ctx.syncToken });
  }

  async createEvent(ctx: SyncContext, ev: OutgoingEvent) {
    const res = await checkResponse(
      await this.http(`${API}/calendars/${encodeURIComponent(ctx.externalCalendarId!)}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(toGoogleBody(ev)),
      }),
      'Google',
    );
    return mapGoogleEvent((await res.json()) as GEvent, ctx.fallbackTimezone);
  }

  async updateEvent(ctx: SyncContext, externalId: string, ev: OutgoingEvent, etag: string | null) {
    const res = await checkResponse(
      await this.http(`${API}/calendars/${encodeURIComponent(ctx.externalCalendarId!)}/events/${encodeURIComponent(externalId)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          'Content-Type': 'application/json',
          ...(etag ? { 'If-Match': etag } : {}),
        },
        body: JSON.stringify(toGoogleBody(ev)),
      }),
      'Google',
    );
    return mapGoogleEvent((await res.json()) as GEvent, ctx.fallbackTimezone);
  }

  async deleteEvent(ctx: SyncContext, externalId: string, etag: string | null) {
    const res = await this.http(
      `${API}/calendars/${encodeURIComponent(ctx.externalCalendarId!)}/events/${encodeURIComponent(externalId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${ctx.accessToken}`, ...(etag ? { 'If-Match': etag } : {}) } },
    );
    if (res.status === 404 || res.status === 410) return;
    await checkResponse(res, 'Google');
  }
}
