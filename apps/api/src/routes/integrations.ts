import { Router } from 'express';
import { connectExternalCalendarsSchema, can } from '@familyhub/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { decryptOptional, encrypt, encryptOptional, pkcePair, randomToken, sha256 } from '../lib/crypto.js';
import { forbidden, notFound, unprocessable } from '../lib/errors.js';
import { logger } from '../logger.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';
import { requireUser } from '../auth/session.js';
import { ctx, householdContext, requireCap } from '../auth/context.js';
import { DEMO_ACCOUNT_PREFIX, providerByKey, providerCatalog, providerFor } from '../calendar/providers/index.js';
import { syncConnection } from '../calendar/sync.js';

const OAUTH_PROVIDERS = { google: 'GOOGLE', microsoft: 'MICROSOFT' } as const;
type OAuthKey = keyof typeof OAUTH_PROVIDERS;

function accountDTO(a: { id: string; provider: string; email: string | null; displayName: string | null; status: string; statusMessage: string | null; ownerMemberId: string; externalAccountId: string; createdAt: Date; _count?: { calendars: number } }) {
  return {
    id: a.id, provider: a.provider, email: a.email, displayName: a.displayName, status: a.status, statusMessage: a.statusMessage,
    ownerMemberId: a.ownerMemberId, isDemo: a.externalAccountId.startsWith(DEMO_ACCOUNT_PREFIX), createdAt: a.createdAt,
    calendarCount: a._count?.calendars ?? 0,
  };
}

/** Public OAuth callbacks (not household scoped; household comes from the stored state). */
export function integrationCallbackRouter() {
  const router = Router();
  for (const key of Object.keys(OAUTH_PROVIDERS) as OAuthKey[]) {
    router.get(`/api/v1/integrations/${key}/callback`, requireUser, async (req, res) => {
      const back = (q: Record<string, string>) => res.redirect(`${config.WEB_ORIGIN}/settings/calendars?${new URLSearchParams(q)}`);
      try {
        const { state, code, error } = req.query as Record<string, string | undefined>;
        if (error) return back({ error: `The provider returned: ${error}` });
        if (!state || !code) return back({ error: 'Missing authorization response' });
        const row = await prisma.oAuthState.findUnique({ where: { stateHash: sha256(state) } });
        if (!row || row.expiresAt < new Date() || row.userId !== req.auth!.userId || row.provider !== OAUTH_PROVIDERS[key]) {
          return back({ error: 'This connection link expired. Please try again.' });
        }
        await prisma.oAuthState.delete({ where: { id: row.id } });
        const provider = providerByKey(key);
        const { tokens, account } = await provider.exchangeCode!(code, decryptOptional(row.encryptedCodeVerifier)!);
        const saved = await prisma.calendarAccount.upsert({
          where: { householdId_provider_externalAccountId: { householdId: row.householdId, provider: OAUTH_PROVIDERS[key], externalAccountId: account.externalAccountId } },
          create: {
            householdId: row.householdId, ownerMemberId: row.memberId, provider: OAUTH_PROVIDERS[key], externalAccountId: account.externalAccountId,
            email: account.email ?? null, displayName: account.displayName ?? null, encryptedAccessToken: encrypt(tokens.accessToken),
            encryptedRefreshToken: encryptOptional(tokens.refreshToken), tokenExpiresAt: tokens.expiresAt ?? null, scopes: tokens.scopes ?? [],
          },
          update: {
            encryptedAccessToken: encrypt(tokens.accessToken),
            ...(tokens.refreshToken ? { encryptedRefreshToken: encrypt(tokens.refreshToken) } : {}),
            tokenExpiresAt: tokens.expiresAt ?? null, scopes: tokens.scopes ?? [], status: 'ACTIVE', statusMessage: null,
          },
        });
        await audit(req, { householdId: row.householdId, action: 'calendar_account.connected', entityType: 'calendar_account', entityId: saved.id, metadata: { provider: key } });
        return back({ account: saved.id });
      } catch (err) {
        logger.warn({ err }, 'oauth callback failed');
        return back({ error: 'Could not complete the connection. Please try again.' });
      }
    });
  }
  return router;
}

export function integrationsRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };

  route(m, { method: 'get', path: '/integrations/providers', summary: 'Available calendar providers and whether they are configured', tags: ['Integrations'] }, () => providerCatalog());

  route(
    m,
    { method: 'post', path: '/integrations/:provider/start', summary: 'Begin OAuth (returns the provider authorization URL)', tags: ['Integrations'], middleware: [requireUser, requireCap('calendars.connect')] },
    async (req) => {
      const c = ctx(req);
      const key = req.params.provider as OAuthKey;
      if (!(key in OAUTH_PROVIDERS)) throw notFound('Provider');
      const provider = providerByKey(key);
      if (!provider.isConfigured()) {
        throw unprocessable('PROVIDER_NOT_CONFIGURED', `${key === 'google' ? 'Google' : 'Microsoft'} sign-in is not configured on this server. See docs/integrations.md.`);
      }
      const state = randomToken(24);
      const { verifier, challenge } = pkcePair();
      await prisma.oAuthState.create({
        data: {
          stateHash: sha256(state), provider: OAUTH_PROVIDERS[key], householdId: c.householdId, userId: req.auth!.userId!,
          memberId: c.member!.id, encryptedCodeVerifier: encrypt(verifier), expiresAt: new Date(Date.now() + 10 * 60000),
        },
      });
      return { url: provider.buildAuthorizationUrl!(state, challenge) };
    },
  );

  route(
    m,
    { method: 'post', path: '/integrations/demo/connect', summary: 'Connect the simulated demo account (development only)', tags: ['Integrations'], status: 201, middleware: [requireUser, requireCap('calendars.connect')] },
    async (req) => {
      const c = ctx(req);
      if (!config.ENABLE_DEMO_PROVIDER) throw unprocessable('PROVIDER_NOT_CONFIGURED', 'The demo provider is disabled');
      const externalAccountId = `${DEMO_ACCOUNT_PREFIX}${c.member!.id}`;
      const acct = await prisma.calendarAccount.upsert({
        where: { householdId_provider_externalAccountId: { householdId: c.householdId, provider: 'GOOGLE', externalAccountId } },
        create: { householdId: c.householdId, ownerMemberId: c.member!.id, provider: 'GOOGLE', externalAccountId, email: 'demo-account@example.com', displayName: 'Demo account' },
        update: { status: 'ACTIVE', statusMessage: null },
        include: { _count: { select: { calendars: true } } },
      });
      await audit(req, { householdId: c.householdId, action: 'calendar_account.connected', entityType: 'calendar_account', entityId: acct.id, metadata: { provider: 'demo' } });
      return accountDTO(acct);
    },
  );

  route(m, { method: 'get', path: '/calendar-accounts', summary: 'Connected calendar accounts', tags: ['Integrations'], middleware: [requireUser] }, async (req) => {
    const c = ctx(req);
    const admin = can(c.actor, 'calendars.manage');
    const rows = await prisma.calendarAccount.findMany({
      where: { householdId: c.householdId, ...(admin ? {} : { ownerMemberId: c.member!.id }) },
      include: { _count: { select: { calendars: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(accountDTO);
  });

  async function ownAccount(req: Parameters<typeof ctx>[0], id: string) {
    const c = ctx(req);
    const acct = await prisma.calendarAccount.findFirst({ where: { id, householdId: c.householdId } });
    if (!acct) throw notFound('Account');
    const isOwner = c.member?.id === acct.ownerMemberId;
    return { acct, isOwner, c };
  }

  route(m, { method: 'get', path: '/calendar-accounts/:accountId/calendars', summary: 'Calendars available in a connected account', tags: ['Integrations'], middleware: [requireUser] }, async (req) => {
    const { acct, isOwner } = await ownAccount(req, req.params.accountId!);
    if (!isOwner) throw forbidden('Only the account owner can choose which calendars to import');
    const provider = providerFor(acct.provider, acct.externalAccountId);
    if (!provider) throw notFound('Provider');
    const remote = await provider.listCalendars(decryptOptional(acct.encryptedAccessToken), acct.externalAccountId).catch((e: Error) => {
      throw unprocessable('PROVIDER_ERROR', `Could not list calendars: ${e.message}`);
    });
    const connected = await prisma.calendarConnection.findMany({ where: { accountId: acct.id }, select: { externalCalendarId: true, calendarId: true } });
    const byExt = new Map(connected.map((x) => [x.externalCalendarId, x.calendarId]));
    return remote.map((r) => ({ ...r, connectedCalendarId: byExt.get(r.externalId) ?? null }));
  });

  route(
    m,
    { method: 'post', path: '/calendars/connect', summary: 'Import selected calendars from a connected account', tags: ['Integrations'], body: connectExternalCalendarsSchema, status: 201, middleware: [requireUser, requireCap('calendars.connect')] },
    async (req, _res, { body }) => {
      const { acct, isOwner, c } = await ownAccount(req, body.accountId);
      if (!isOwner) throw forbidden('Only the account owner can import its calendars');
      const provider = providerFor(acct.provider, acct.externalAccountId)!;
      const remote = new Map((await provider.listCalendars(decryptOptional(acct.encryptedAccessToken), acct.externalAccountId)).map((r) => [r.externalId, r]));
      const results = [];
      for (const sel of body.calendars) {
        const r = remote.get(sel.externalCalendarId);
        if (!r) throw unprocessable('UNKNOWN_CALENDAR', `Calendar ${sel.name} was not found in this account`);
        const existing = await prisma.calendarConnection.findFirst({ where: { accountId: acct.id, externalCalendarId: r.externalId } });
        if (existing) continue;
        const twoWay = sel.syncMode === 'TWO_WAY' && !r.readOnly && provider.capabilities.twoWay;
        const cal = await prisma.calendar.create({
          data: {
            householdId: c.householdId, accountId: acct.id, ownerMemberId: sel.ownerMemberId ?? acct.ownerMemberId, name: sel.name,
            color: sel.color ?? r.color ?? '#0ea5e9', category: sel.category, source: acct.provider, visibility: sel.visibility,
            showOnWallDisplay: sel.showOnWallDisplay, isReadOnly: r.readOnly, timezone: r.timezone ?? null,
            connection: {
              create: {
                accountId: acct.id, externalCalendarId: r.externalId, syncMode: twoWay ? 'TWO_WAY' : 'READ_ONLY',
                refreshIntervalMinutes: 15, syncState: { create: {} },
              },
            },
          },
          include: { connection: true },
        });
        const sync = await syncConnection(cal.connection!.id, 'initial');
        results.push({ calendarId: cal.id, name: cal.name, syncMode: cal.connection!.syncMode, sync });
      }
      await audit(req, { householdId: c.householdId, action: 'calendar_account.calendars_imported', entityType: 'calendar_account', entityId: acct.id, metadata: { count: results.length } });
      realtime.publish(c.householdId, { type: 'calendars.changed' });
      realtime.publish(c.householdId, { type: 'events.changed' });
      return results;
    },
  );

  route(m, { method: 'delete', path: '/calendar-accounts/:accountId', summary: 'Disconnect an account, revoke tokens and remove its calendars', tags: ['Integrations'], middleware: [requireUser] }, async (req) => {
    const { acct, isOwner, c } = await ownAccount(req, req.params.accountId!);
    if (!isOwner && !can(c.actor, 'calendars.manage')) throw forbidden();
    const provider = providerFor(acct.provider, acct.externalAccountId);
    await provider?.disconnect?.({ accessToken: decryptOptional(acct.encryptedAccessToken), refreshToken: decryptOptional(acct.encryptedRefreshToken) }).catch(() => undefined);
    await prisma.$transaction([prisma.calendar.deleteMany({ where: { accountId: acct.id } }), prisma.calendarAccount.delete({ where: { id: acct.id } })]);
    await audit(req, { householdId: c.householdId, action: 'calendar_account.disconnected', entityType: 'calendar_account', entityId: acct.id });
    realtime.publish(c.householdId, { type: 'calendars.changed' });
    realtime.publish(c.householdId, { type: 'events.changed' });
    return undefined;
  });

  return router;
}
