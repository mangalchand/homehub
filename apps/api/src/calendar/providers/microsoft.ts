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

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const MICROSOFT_SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Calendars.ReadWrite'];

interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}
interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  sensitivity?: string;
  lastModifiedDateTime?: string;
  changeKey?: string;
  iCalUId?: string;
  seriesMasterId?: string;
  originalStart?: string;
  '@removed'?: { reason: string };
}

const asUtc = (t: GraphDateTime | undefined) => (t ? new Date(t.dateTime.endsWith('Z') ? t.dateTime : `${t.dateTime}Z`) : new Date(0));

/**
 * Map a Graph calendarView item. We request `Prefer: outlook.timezone="UTC"`, so dateTime values are UTC.
 * calendarView/delta returns expanded occurrences, so each occurrence is stored as its own event.
 */
export function mapGraphEvent(g: GraphEvent, fallbackTz: string): RemoteEvent {
  return {
    externalId: g.id,
    iCalUid: g.iCalUId ?? null,
    title: g.subject || '(No title)',
    description: g.bodyPreview ?? null,
    location: g.location?.displayName || null,
    startAt: asUtc(g.start),
    endAt: asUtc(g.end),
    allDay: Boolean(g.isAllDay),
    timezone: g.isAllDay ? 'UTC' : fallbackTz,
    rrule: null,
    exdates: [],
    recurringExternalId: null,
    originalStartAt: g.originalStart ? new Date(g.originalStart) : null,
    status: g.isCancelled ? 'CANCELLED' : g.showAs === 'tentative' ? 'TENTATIVE' : 'CONFIRMED',
    isPrivate: g.sensitivity === 'private' || g.sensitivity === 'confidential',
    updatedAt: g.lastModifiedDateTime ? new Date(g.lastModifiedDateTime) : null,
    etag: g.changeKey ?? null,
  };
}

function toGraphBody(ev: OutgoingEvent) {
  const t = (d: Date) => ({ dateTime: ev.allDay ? `${d.toISOString().slice(0, 10)}T00:00:00` : d.toISOString().replace('Z', ''), timeZone: 'UTC' });
  return {
    subject: ev.title,
    body: ev.description ? { contentType: 'text', content: ev.description } : undefined,
    location: ev.location ? { displayName: ev.location } : undefined,
    start: t(ev.startAt),
    end: t(ev.endAt),
    isAllDay: ev.allDay,
    sensitivity: ev.isPrivate ? 'private' : 'normal',
  };
}

export class MicrosoftGraphProvider implements CalendarProvider {
  type = 'MICROSOFT' as const;
  capabilities = { oauth: true, twoWay: true, incremental: true, push: true };
  constructor(private http: FetchLike = fetch) {}

  isConfigured() {
    return providerConfigured.microsoft();
  }
  private authority() {
    return `https://login.microsoftonline.com/${encodeURIComponent(config.MICROSOFT_TENANT)}/oauth2/v2.0`;
  }
  private redirectUri() {
    return `${config.API_PUBLIC_URL}/api/v1/integrations/microsoft/callback`;
  }

  buildAuthorizationUrl(state: string, codeChallenge: string) {
    const params = new URLSearchParams({
      client_id: config.MICROSOFT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      response_mode: 'query',
      scope: MICROSOFT_SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `${this.authority()}/authorize?${params}`;
  }

  private async token(body: Record<string, string>) {
    const res = await checkResponse(
      await this.http(`${this.authority()}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.MICROSOFT_CLIENT_ID, client_secret: config.MICROSOFT_CLIENT_SECRET, ...body }),
      }),
      'Microsoft',
    );
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
  }

  async exchangeCode(code: string, codeVerifier: string) {
    const t = await this.token({ code, grant_type: 'authorization_code', redirect_uri: this.redirectUri(), code_verifier: codeVerifier, scope: MICROSOFT_SCOPES.join(' ') });
    const me = (await (
      await checkResponse(await this.http(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${t.access_token}` } }), 'Microsoft')
    ).json()) as { id: string; mail?: string; userPrincipalName?: string; displayName?: string };
    return {
      tokens: { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: new Date(Date.now() + t.expires_in * 1000), scopes: t.scope.split(' ') },
      account: { externalAccountId: me.id, email: me.mail ?? me.userPrincipalName ?? null, displayName: me.displayName ?? null },
    };
  }

  async refreshAuthorization(refreshToken: string) {
    const t = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: MICROSOFT_SCOPES.join(' ') });
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
  }

  async listCalendars(accessToken: string | null): Promise<RemoteCalendar[]> {
    const res = await checkResponse(await this.http(`${GRAPH}/me/calendars?$top=100`, { headers: { Authorization: `Bearer ${accessToken}` } }), 'Microsoft');
    const data = (await res.json()) as { value: { id: string; name: string; hexColor?: string; canEdit: boolean; isDefaultCalendar?: boolean }[] };
    return data.value.map((c) => ({
      externalId: c.id,
      name: c.name,
      color: c.hexColor || null,
      readOnly: !c.canEdit,
      primary: Boolean(c.isDefaultCalendar),
    }));
  }

  private async runDelta(ctx: SyncContext, startUrl: string, full: boolean): Promise<SyncResult> {
    const events: RemoteEvent[] = [];
    const deleted: string[] = [];
    let url: string | undefined = startUrl;
    let deltaLink: string | null = null;
    while (url) {
      const res = await checkResponse(
        await this.http(url, {
          headers: { Authorization: `Bearer ${ctx.accessToken}`, Prefer: 'outlook.timezone="UTC", odata.maxpagesize=200' },
        }),
        'Microsoft',
      );
      const page = (await res.json()) as { value: GraphEvent[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
      for (const item of page.value) {
        if (item['@removed'] || item.isCancelled) deleted.push(item.id);
        else events.push(mapGraphEvent(item, ctx.fallbackTimezone));
      }
      url = page['@odata.nextLink'];
      deltaLink = page['@odata.deltaLink'] ?? deltaLink;
    }
    return { events, deletedExternalIds: deleted, fullSync: full, nextSyncToken: deltaLink };
  }

  initialSync(ctx: SyncContext) {
    const start = new Date(Date.now() - 180 * 86400000).toISOString();
    const end = new Date(Date.now() + 365 * 86400000).toISOString();
    const url = `${GRAPH}/me/calendars/${encodeURIComponent(ctx.externalCalendarId!)}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`;
    return this.runDelta(ctx, url, true);
  }

  incrementalSync(ctx: SyncContext) {
    if (!ctx.syncToken || !ctx.syncToken.startsWith(GRAPH)) return this.initialSync(ctx);
    return this.runDelta(ctx, ctx.syncToken, false);
  }

  async createEvent(ctx: SyncContext, ev: OutgoingEvent) {
    const res = await checkResponse(
      await this.http(`${GRAPH}/me/calendars/${encodeURIComponent(ctx.externalCalendarId!)}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.accessToken}`, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"' },
        body: JSON.stringify(toGraphBody(ev)),
      }),
      'Microsoft',
    );
    return mapGraphEvent((await res.json()) as GraphEvent, ctx.fallbackTimezone);
  }

  async updateEvent(ctx: SyncContext, externalId: string, ev: OutgoingEvent) {
    const res = await checkResponse(
      await this.http(`${GRAPH}/me/events/${encodeURIComponent(externalId)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${ctx.accessToken}`, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"' },
        body: JSON.stringify(toGraphBody(ev)),
      }),
      'Microsoft',
    );
    return mapGraphEvent((await res.json()) as GraphEvent, ctx.fallbackTimezone);
  }

  async deleteEvent(ctx: SyncContext, externalId: string) {
    const res = await this.http(`${GRAPH}/me/events/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
    });
    if (res.status === 404) return;
    await checkResponse(res, 'Microsoft');
  }
}
