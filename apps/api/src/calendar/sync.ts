import type { CalendarConnection, CalendarSyncState, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { decryptOptional, encrypt } from '../lib/crypto.js';
import { logger } from '../logger.js';
import { realtime } from '../lib/realtime.js';
import { providerFor } from './providers/index.js';
import {
  PreconditionFailedError,
  ProviderAuthError,
  ProviderRateLimitError,
  SyncTokenExpiredError,
  type CalendarProvider,
  type OutgoingEvent,
  type RemoteEvent,
  type SyncContext,
  type SyncResult,
} from './providers/types.js';

const LOCK_MS = 5 * 60000;
const MAX_BACKOFF_MS = 6 * 3600000;

export interface ApplyCounts {
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
}

type FullConnection = CalendarConnection & {
  syncState: CalendarSyncState | null;
  calendar: { id: string; householdId: string; source: import('@prisma/client').CalendarProviderType; timezone: string | null; household: { timezone: string } };
  account: {
    id: string;
    externalAccountId: string;
    encryptedAccessToken: string | null;
    encryptedRefreshToken: string | null;
    tokenExpiresAt: Date | null;
    status: string;
  } | null;
};

function remoteToData(r: RemoteEvent) {
  return {
    title: r.title,
    description: r.description ?? null,
    location: r.location ?? null,
    startAt: r.startAt,
    endAt: r.endAt,
    allDay: r.allDay,
    timezone: r.timezone,
    rrule: r.rrule ?? null,
    exdates: r.exdates,
    originalStartAt: r.originalStartAt ?? null,
    status: r.status,
    isPrivate: r.isPrivate,
    externalICalUid: r.iCalUid ?? null,
    externalEtag: r.etag ?? null,
    externalUpdatedAt: r.updatedAt ?? null,
  };
}

/**
 * Apply a provider snapshot/delta to local storage. Local edits awaiting provider confirmation (PENDING_*) are
 * never silently overwritten: if the remote copy also changed, a SYNC conflict is recorded for a human to resolve.
 */
export async function applyRemoteEvents(
  calendar: { id: string; householdId: string },
  result: Pick<SyncResult, 'events' | 'deletedExternalIds' | 'fullSync'>,
): Promise<ApplyCounts> {
  const counts: ApplyCounts = { created: 0, updated: 0, deleted: 0, conflicts: 0 };
  const existing = await prisma.calendarEvent.findMany({
    where: { calendarId: calendar.id, externalId: { not: null } },
    select: { id: true, externalId: true, syncState: true, externalUpdatedAt: true, externalEtag: true, deletedAt: true },
  });
  const byExt = new Map(existing.map((e) => [e.externalId!, e]));
  const seen = new Set<string>();
  // Series masters first so exceptions can reference them.
  const ordered = [...result.events].sort((a, b) => Number(Boolean(a.recurringExternalId)) - Number(Boolean(b.recurringExternalId)));
  const idByExt = new Map(existing.map((e) => [e.externalId!, e.id]));

  for (const r of ordered) {
    seen.add(r.externalId);
    const local = byExt.get(r.externalId);
    const masterId = r.recurringExternalId ? (idByExt.get(r.recurringExternalId) ?? null) : null;
    const data = { ...remoteToData(r), recurringEventId: masterId };
    if (!local) {
      const created = await prisma.calendarEvent.create({
        data: { ...data, householdId: calendar.householdId, calendarId: calendar.id, externalId: r.externalId, syncState: 'SYNCED' },
      });
      idByExt.set(r.externalId, created.id);
      counts.created++;
      continue;
    }
    const remoteChanged =
      (r.etag && r.etag !== local.externalEtag) ||
      (r.updatedAt && (!local.externalUpdatedAt || r.updatedAt.getTime() !== local.externalUpdatedAt.getTime())) ||
      (!r.etag && !r.updatedAt);
    if (!remoteChanged && !local.deletedAt) continue;
    if (local.syncState.startsWith('PENDING')) {
      if (remoteChanged) {
        await prisma.eventConflict.create({
          data: {
            householdId: calendar.householdId,
            type: 'SYNC',
            eventId: local.id,
            details: { reason: 'Changed both here and at the provider', remote: JSON.parse(JSON.stringify(remoteToData(r))) },
          },
        });
        await prisma.calendarEvent.update({ where: { id: local.id }, data: { syncState: 'ERROR', syncError: 'Conflicting change at provider' } });
        counts.conflicts++;
      }
      continue;
    }
    await prisma.calendarEvent.update({
      where: { id: local.id },
      data: { ...data, deletedAt: null, syncState: 'SYNCED', syncError: null, version: { increment: 1 } },
    });
    counts.updated++;
  }

  const toDelete = new Set(result.deletedExternalIds);
  if (result.fullSync) for (const e of existing) if (!seen.has(e.externalId!) && !e.deletedAt) toDelete.add(e.externalId!);
  for (const ext of toDelete) {
    const local = byExt.get(ext);
    if (!local || local.deletedAt || local.syncState === 'PENDING_CREATE') continue;
    await prisma.calendarEvent.update({ where: { id: local.id }, data: { deletedAt: new Date(), syncState: 'SYNCED' } });
    counts.deleted++;
  }
  return counts;
}

async function accessTokenFor(conn: FullConnection, provider: CalendarProvider): Promise<string | null> {
  const acct = conn.account;
  if (!acct) return null;
  let access = decryptOptional(acct.encryptedAccessToken);
  const refresh = decryptOptional(acct.encryptedRefreshToken);
  const expiring = acct.tokenExpiresAt && acct.tokenExpiresAt.getTime() < Date.now() + 60000;
  if ((expiring || !access) && refresh && provider.refreshAuthorization) {
    const t = await provider.refreshAuthorization(refresh);
    access = t.accessToken;
    await prisma.calendarAccount.update({
      where: { id: acct.id },
      data: {
        encryptedAccessToken: encrypt(t.accessToken),
        ...(t.refreshToken ? { encryptedRefreshToken: encrypt(t.refreshToken) } : {}),
        tokenExpiresAt: t.expiresAt ?? null,
        status: 'ACTIVE',
        statusMessage: null,
      },
    });
  }
  return access;
}

const connectionInclude = {
  syncState: true,
  calendar: { select: { id: true, householdId: true, source: true, timezone: true, household: { select: { timezone: true } } } },
  account: {
    select: { id: true, externalAccountId: true, encryptedAccessToken: true, encryptedRefreshToken: true, tokenExpiresAt: true, status: true },
  },
} satisfies Prisma.CalendarConnectionInclude;

async function loadConnection(id: string) {
  return (await prisma.calendarConnection.findUnique({ where: { id }, include: connectionInclude })) as FullConnection | null;
}

async function buildContext(conn: FullConnection, provider: CalendarProvider): Promise<SyncContext> {
  return {
    accessToken: await accessTokenFor(conn, provider),
    externalCalendarId: conn.externalCalendarId,
    sourceUrl: decryptOptional(conn.encryptedSourceUrl),
    syncToken: conn.syncState?.syncToken ?? null,
    fallbackTimezone: conn.calendar.timezone ?? conn.calendar.household.timezone,
    consecutiveFailures: conn.syncState?.consecutiveFailures ?? 0,
    hasSucceededBefore: Boolean(conn.syncState?.lastSuccessAt),
  };
}

export interface SyncOutcome extends ApplyCounts {
  success: boolean;
  skipped?: 'locked' | 'disabled' | 'not_modified';
  error?: string;
}

/** Synchronize one external calendar. Safe to call concurrently: a DB lease prevents overlapping runs. */
export async function syncConnection(connectionId: string, trigger: 'manual' | 'scheduled' | 'initial' | 'webhook'): Promise<SyncOutcome> {
  const empty: ApplyCounts = { created: 0, updated: 0, deleted: 0, conflicts: 0 };
  await prisma.calendarSyncState.upsert({ where: { connectionId }, create: { connectionId }, update: {} });
  const now = new Date();
  const lease = await prisma.calendarSyncState.updateMany({
    where: { connectionId, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS), status: 'RUNNING', lastSyncStartedAt: now },
  });
  if (!lease.count) return { ...empty, success: false, skipped: 'locked' };

  const conn = await loadConnection(connectionId);
  if (!conn) return { ...empty, success: false, skipped: 'disabled' };
  const householdId = conn.calendar.householdId;
  const run = await prisma.calendarSyncRun.create({ data: { connectionId, trigger } });
  const provider = providerFor(conn.calendar.source, conn.account?.externalAccountId);

  try {
    if (!conn.enabled) throw new Error('Sync is paused for this calendar');
    if (!provider) throw new Error('No provider adapter for this calendar');
    if (conn.account && conn.account.status === 'NEEDS_REAUTH') throw new ProviderAuthError('Reconnect this account to resume syncing');
    const sctx = await buildContext(conn, provider);
    let result: SyncResult;
    try {
      result = sctx.syncToken ? await provider.incrementalSync(sctx) : await provider.initialSync(sctx);
    } catch (e) {
      if (!(e instanceof SyncTokenExpiredError)) throw e;
      result = await provider.initialSync({ ...sctx, syncToken: null });
    }
    const counts = result.notModified ? empty : await applyRemoteEvents(conn.calendar, result);
    const interval = conn.refreshIntervalMinutes * 60000;
    await prisma.$transaction([
      prisma.calendarSyncState.update({
        where: { connectionId },
        data: {
          status: 'IDLE', syncToken: result.nextSyncToken, lastSuccessAt: new Date(), lastError: null,
          consecutiveFailures: 0, nextSyncAt: new Date(Date.now() + interval), lockedUntil: null,
        },
      }),
      prisma.calendarSyncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), success: true, ...counts } }),
    ]);
    realtime.publish(householdId, { type: 'calendar.synced', entityId: conn.calendarId });
    return { ...counts, success: true, ...(result.notModified ? { skipped: 'not_modified' as const } : {}) };
  } catch (e) {
    const err = e as Error;
    const failures = (conn.syncState?.consecutiveFailures ?? 0) + 1;
    const backoff = e instanceof ProviderRateLimitError ? e.retryAfterMs : Math.min(60000 * 2 ** (failures - 1), MAX_BACKOFF_MS);
    logger.warn({ connectionId, err: err.message }, 'calendar sync failed');
    await prisma.$transaction([
      prisma.calendarSyncState.update({
        where: { connectionId },
        data: {
          status: 'ERROR', lastError: err.message.slice(0, 500), lastErrorAt: new Date(), consecutiveFailures: failures,
          nextSyncAt: new Date(Date.now() + backoff), lockedUntil: null,
        },
      }),
      prisma.calendarSyncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), success: false, error: err.message.slice(0, 500) } }),
      ...(e instanceof ProviderAuthError && conn.account
        ? [prisma.calendarAccount.update({ where: { id: conn.account.id }, data: { status: 'NEEDS_REAUTH', statusMessage: err.message } })]
        : []),
    ]);
    realtime.publish(householdId, { type: 'calendar.synced', entityId: conn.calendarId });
    return { ...empty, success: false, error: err.message };
  }
}

/** Run all syncs that are due. Called by the worker/scheduler. */
export async function runDueSyncs(limit = 20) {
  const due = await prisma.calendarSyncState.findMany({
    where: { nextSyncAt: { lte: new Date() }, connection: { enabled: true }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
    orderBy: { nextSyncAt: 'asc' },
    take: limit,
    select: { connectionId: true },
  });
  const results = [];
  for (const d of due) results.push(await syncConnection(d.connectionId, 'scheduled'));
  return results;
}

function toOutgoing(ev: {
  title: string; description: string | null; location: string | null; startAt: Date; endAt: Date;
  allDay: boolean; timezone: string; rrule: string | null; isPrivate: boolean;
}): OutgoingEvent {
  return {
    title: ev.title, description: ev.description, location: ev.location, startAt: ev.startAt, endAt: ev.endAt,
    allDay: ev.allDay, timezone: ev.timezone, rrule: ev.rrule, isPrivate: ev.isPrivate,
  };
}

/**
 * Push a locally edited event on a two-way calendar to its provider. The event stays PENDING_* until the
 * provider confirms; failures are surfaced as ERROR with a message (and a conflict for 412 responses).
 */
export async function pushEventChange(eventId: string): Promise<void> {
  const ev = await prisma.calendarEvent.findUnique({ where: { id: eventId }, include: { calendar: { include: { connection: true } } } });
  if (!ev || !ev.calendar.connection || !ev.syncState.startsWith('PENDING')) return;
  const conn = await loadConnection(ev.calendar.connection.id);
  if (!conn) return;
  const provider = providerFor(conn.calendar.source, conn.account?.externalAccountId);
  if (!provider?.createEvent || !provider.updateEvent || !provider.deleteEvent) return;
  try {
    const sctx = await buildContext(conn, provider);
    if (ev.syncState === 'PENDING_DELETE') {
      if (ev.externalId) await provider.deleteEvent(sctx, ev.externalId, ev.externalEtag);
      await prisma.calendarEvent.update({ where: { id: ev.id }, data: { syncState: 'SYNCED', syncError: null } });
    } else {
      const remote =
        ev.syncState === 'PENDING_CREATE' || !ev.externalId
          ? await provider.createEvent(sctx, toOutgoing(ev))
          : await provider.updateEvent(sctx, ev.externalId, toOutgoing(ev), ev.externalEtag);
      await prisma.calendarEvent.update({
        where: { id: ev.id },
        data: {
          externalId: remote.externalId, externalEtag: remote.etag ?? null, externalUpdatedAt: remote.updatedAt ?? null,
          externalICalUid: remote.iCalUid ?? null, syncState: 'SYNCED', syncError: null,
        },
      });
    }
  } catch (e) {
    const err = e as Error;
    if (e instanceof PreconditionFailedError) {
      await prisma.eventConflict.create({
        data: { householdId: ev.householdId, type: 'SYNC', eventId: ev.id, details: { reason: 'The event was changed at the provider before your edit was saved' } },
      });
    }
    if (e instanceof ProviderAuthError && conn.account) {
      await prisma.calendarAccount.update({ where: { id: conn.account.id }, data: { status: 'NEEDS_REAUTH', statusMessage: err.message } });
    }
    await prisma.calendarEvent.update({ where: { id: ev.id }, data: { syncState: 'ERROR', syncError: err.message.slice(0, 500) } });
  }
  realtime.publish(ev.householdId, { type: 'events.changed', entityId: ev.calendarId });
}

/** Retry pushes that failed or never ran (e.g. API restarted mid-request). */
export async function retryPendingPushes(limit = 50) {
  const pending = await prisma.calendarEvent.findMany({
    where: { syncState: { in: ['PENDING_CREATE', 'PENDING_UPDATE', 'PENDING_DELETE'] }, updatedAt: { lt: new Date(Date.now() - 30000) } },
    select: { id: true },
    take: limit,
  });
  for (const p of pending) await pushEventChange(p.id);
}
