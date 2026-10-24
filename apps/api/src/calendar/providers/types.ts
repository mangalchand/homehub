import type { CalendarProviderType } from '@prisma/client';

export interface RemoteCalendar {
  externalId: string;
  name: string;
  color?: string | null;
  readOnly: boolean;
  primary?: boolean;
  timezone?: string | null;
}

export interface RemoteEvent {
  externalId: string;
  iCalUid?: string | null;
  title: string;
  description?: string | null;
  location?: string | null;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  timezone: string;
  rrule?: string | null;
  exdates: Date[];
  /** For recurrence exceptions: externalId of the series master. */
  recurringExternalId?: string | null;
  originalStartAt?: Date | null;
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  isPrivate: boolean;
  updatedAt?: Date | null;
  etag?: string | null;
}

export interface SyncResult {
  events: RemoteEvent[];
  deletedExternalIds: string[];
  /** Full snapshot: local events missing from `events` are deleted. */
  fullSync: boolean;
  nextSyncToken: string | null;
  notModified?: boolean;
}

export interface ProviderCapabilities {
  oauth: boolean;
  twoWay: boolean;
  incremental: boolean;
  push: boolean;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
}

export interface ProviderAccountInfo {
  externalAccountId: string;
  email?: string | null;
  displayName?: string | null;
}

export interface SyncContext {
  accessToken: string | null;
  externalCalendarId: string | null;
  sourceUrl: string | null;
  syncToken: string | null;
  fallbackTimezone: string;
  /** Number of prior consecutive failures (used by the demo provider). */
  consecutiveFailures: number;
  hasSucceededBefore: boolean;
}

export interface OutgoingEvent {
  title: string;
  description: string | null;
  location: string | null;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  timezone: string;
  rrule: string | null;
  isPrivate: boolean;
}

/** Provider adapter contract. Not every provider supports every operation — check `capabilities`. */
export interface CalendarProvider {
  type: CalendarProviderType;
  capabilities: ProviderCapabilities;
  isConfigured(): boolean;
  buildAuthorizationUrl?(state: string, codeChallenge: string): string;
  exchangeCode?(code: string, codeVerifier: string): Promise<{ tokens: TokenSet; account: ProviderAccountInfo }>;
  refreshAuthorization?(refreshToken: string): Promise<TokenSet>;
  disconnect?(tokens: { accessToken: string | null; refreshToken: string | null }): Promise<void>;
  listCalendars(accessToken: string | null, accountExternalId?: string): Promise<RemoteCalendar[]>;
  initialSync(ctx: SyncContext): Promise<SyncResult>;
  incrementalSync(ctx: SyncContext): Promise<SyncResult>;
  createEvent?(ctx: SyncContext, ev: OutgoingEvent): Promise<RemoteEvent>;
  updateEvent?(ctx: SyncContext, externalId: string, ev: OutgoingEvent, etag: string | null): Promise<RemoteEvent>;
  deleteEvent?(ctx: SyncContext, externalId: string, etag: string | null): Promise<void>;
}

export class ProviderAuthError extends Error {
  readonly kind = 'auth';
}
export class ProviderRateLimitError extends Error {
  readonly kind = 'rate_limit';
  constructor(message: string, public retryAfterMs: number) {
    super(message);
  }
}
export class SyncTokenExpiredError extends Error {
  readonly kind = 'sync_token_expired';
}
export class PreconditionFailedError extends Error {
  readonly kind = 'precondition_failed';
}
export class ProviderUnavailableError extends Error {
  readonly kind = 'unavailable';
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Map common HTTP failures to typed provider errors. */
export async function checkResponse(res: Response, provider: string): Promise<Response> {
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  if (res.status === 401) throw new ProviderAuthError(`${provider}: authorization expired or revoked`);
  if (res.status === 403 && /rate|quota/i.test(text)) throw new ProviderRateLimitError(`${provider}: rate limited`, 60000);
  if (res.status === 403) throw new ProviderAuthError(`${provider}: permission denied`);
  if (res.status === 410) throw new SyncTokenExpiredError(`${provider}: sync token expired`);
  if (res.status === 412) throw new PreconditionFailedError(`${provider}: event changed remotely`);
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? 60) * 1000;
    throw new ProviderRateLimitError(`${provider}: rate limited`, retry);
  }
  if (res.status >= 500) throw new ProviderUnavailableError(`${provider}: service unavailable (${res.status})`);
  throw new Error(`${provider}: request failed (${res.status}) ${text.slice(0, 200)}`);
}
