import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { can, createTaskSchema, type Actor, type MemberRole } from '@familyhub/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { realtime } from '../lib/realtime.js';
import { notify } from '../lib/notify.js';
import { categorizeGrocery } from '../lib/grocery.js';
import { requireUser } from '../auth/session.js';
import { ctx, householdContext } from '../auth/context.js';
import { listOccurrences } from '../calendar/service.js';
import { pointBalances } from './tasks.js';
import { buildEveningSummary } from '../jobs/eveningSummary.js';
import { verifyAlexaRequest } from '../lib/alexaVerify.js';

export const ALEXA_ACCESS_TTL_S = 3600;
const CODE_TTL_MS = 5 * 60_000;
const REDIRECT_HOSTS = ['pitangui.amazon.com', 'layla.amazon.com', 'alexa.amazon.co.jp'];
export const alexaConfigured = () => Boolean(config.ALEXA_CLIENT_ID && config.ALEXA_CLIENT_SECRET);

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

export function validAlexaRedirect(raw: string) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.port && REDIRECT_HOSTS.includes(u.hostname) && u.pathname.startsWith('/api/skill/link/') && !u.hash;
  } catch {
    return false;
  }
}

const authorizeSchema = z.object({
  clientId: z.string().min(1).max(200),
  redirectUri: z.string().url().max(500),
  state: z.string().min(1).max(2000),
  householdId: z.string().uuid(),
  codeChallenge: z.string().min(43).max(128).optional(),
  codeChallengeMethod: z.literal('S256').optional(),
});

async function activeMember(userId: string, householdId: string) {
  const m = await prisma.householdMember.findFirst({ where: { userId, householdId, isActive: true } });
  return m && !(m.accessExpiresAt && m.accessExpiresAt < new Date()) ? m : null;
}

const oauthError = (res: Response, status: number, error: string) => res.status(status).set('Cache-Control', 'no-store').json({ error });

function clientCredentials(req: Request) {
  const h = req.get('authorization');
  if (h?.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').map((s) => decodeURIComponent(s));
    return { id: id ?? '', secret: secret ?? '' };
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  return { id: String(b.client_id ?? ''), secret: String(b.client_secret ?? '') };
}

async function issueTokens(grantId: string | null, data: { userId: string; householdId: string }) {
  const access = randomToken(32);
  const refresh = randomToken(48);
  const accessExpiresAt = new Date(Date.now() + ALEXA_ACCESS_TTL_S * 1000);
  if (grantId) {
    await prisma.alexaGrant.update({ where: { id: grantId }, data: { accessTokenHash: sha256(access), accessExpiresAt, refreshTokenHash: sha256(refresh) } });
  } else {
    await prisma.alexaGrant.create({ data: { ...data, accessTokenHash: sha256(access), accessExpiresAt, refreshTokenHash: sha256(refresh) } });
  }
  return { access_token: access, token_type: 'Bearer', expires_in: ALEXA_ACCESS_TTL_S, refresh_token: refresh };
}

// ── Alexa response helpers ──
const speech = (text: string) => ({ type: 'PlainText', text: text.slice(0, 7000) });
export const alexaSay = (text: string, keepOpen = false) => ({
  version: '1.0',
  response: { outputSpeech: speech(text), ...(keepOpen ? { reprompt: { outputSpeech: speech('What would you like to do?') } } : {}), shouldEndSession: !keepOpen },
});
const linkAccount = () => ({
  version: '1.0',
  response: { outputSpeech: speech('Please link your FamilyHub account in the Alexa app, then try again.'), card: { type: 'LinkAccount' }, shouldEndSession: true },
});
const HELP = 'You can say: add milk to the grocery list, add a task to call the plumber, what is on today, what is left to do, how many points do we have, or read my notifications.';
const listWords = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

interface AlexaBody {
  request?: { type?: string; timestamp?: string; intent?: { name?: string; slots?: Record<string, { value?: string }> } };
  context?: { System?: { user?: { accessToken?: string }; application?: { applicationId?: string } } };
  session?: { user?: { accessToken?: string }; application?: { applicationId?: string } };
}

type Linked = { householdId: string; timezone: string; householdName: string; actor: Extract<Actor, { kind: 'member' }> };

async function linkedFromToken(token: string | undefined): Promise<Linked | null> {
  if (!token) return null;
  const g = await prisma.alexaGrant.findUnique({ where: { accessTokenHash: sha256(token) }, include: { household: true } });
  if (!g || g.revokedAt || g.accessExpiresAt < new Date()) return null;
  const m = await activeMember(g.userId, g.householdId);
  if (!m) return null;
  void prisma.alexaGrant.update({ where: { id: g.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { householdId: g.householdId, timezone: g.household.timezone, householdName: g.household.name, actor: { kind: 'member', memberId: m.id, userId: g.userId, role: m.role as MemberRole } };
}

async function addTask(l: Linked, title: string) {
  if (!can(l.actor, 'tasks.manage')) return 'Only parents can add tasks from Alexa.';
  const body = createTaskSchema.parse({ title: title.slice(0, 200) });
  const t = await prisma.task.create({
    data: { householdId: l.householdId, kind: 'TASK', title: body.title, priority: body.priority, points: 0, requiresApproval: false, rotate: false, checklist: body.checklist, createdById: l.actor.userId },
  });
  await audit(null, { householdId: l.householdId, action: 'task.created', entityType: 'task', entityId: t.id, metadata: { via: 'alexa' } });
  realtime.publish(l.householdId, { type: 'tasks.changed', entityId: t.id });
  void notify(l.householdId, { type: 'task.created', title: `New task: ${t.title}`, url: '/chores', householdFeed: true }, { except: l.actor.memberId });
  return `Added the task ${t.title}.`;
}

async function addToList(l: Linked, rawItems: string, listName?: string) {
  if (!can(l.actor, 'lists.write')) return 'You do not have permission to change lists.';
  const lists = await prisma.list.findMany({ where: { householdId: l.householdId, deletedAt: null, isTemplate: false }, orderBy: { createdAt: 'asc' } });
  const want = (listName ?? '').toLowerCase().replace(/\b(list|the|my|our)\b/g, '').trim();
  const list =
    (want && lists.find((x) => x.name.toLowerCase() === want)) ||
    (want && lists.find((x) => x.name.toLowerCase().includes(want))) ||
    ((!want || /grocer|shop/.test(want)) && lists.find((x) => x.type === 'GROCERY')) ||
    null;
  if (!list) return want ? `I could not find a list called ${listName}.` : 'There is no grocery list in FamilyHub yet.';
  const names = rawItems.split(/\s*(?:,|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (!names.length) return 'What should I add?';
  const max = await prisma.listItem.aggregate({ where: { listId: list.id }, _max: { sortOrder: true } });
  let order = max._max.sortOrder ?? 0;
  for (const name of names) {
    const item = await prisma.listItem.create({
      data: { id: randomUUID(), householdId: l.householdId, listId: list.id, name: name.slice(0, 200), category: list.type === 'GROCERY' ? categorizeGrocery(name) : null, sortOrder: ++order },
    });
    void notify(l.householdId, { type: 'list.item_added', title: `Added to ${list.name}`, body: item.name, url: `/lists/${list.id}` }, { except: l.actor.memberId, dedupeKey: `listadd:${item.id}` });
  }
  realtime.publish(l.householdId, { type: 'lists.changed', entityId: list.id });
  return `Added ${listWords(names)} to ${list.name}.`;
}

async function agenda(l: Linked, date?: string) {
  const day = (date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? DateTime.fromISO(date, { zone: l.timezone }) : DateTime.now().setZone(l.timezone)).startOf('day');
  const events = await listOccurrences(l.householdId, l.actor, { start: day.toJSDate(), end: day.plus({ days: 1 }).toJSDate() });
  const label = day.hasSame(DateTime.now().setZone(l.timezone), 'day') ? 'today' : day.toFormat('cccc, LLLL d');
  if (!events.length) return `Nothing is on the calendar for ${label}.`;
  const items = events.slice(0, 6).map((e) => (e.allDay ? `${e.title}, all day` : `${e.title} at ${DateTime.fromISO(e.startAt).setZone(l.timezone).toFormat('h:mm a')}`));
  return `${plural(events.length, 'event')} ${label}: ${listWords(items)}${events.length > 6 ? `, and ${events.length - 6} more` : ''}.`;
}

async function points(l: Linked) {
  const [members, balances] = await Promise.all([
    prisma.householdMember.findMany({ where: { householdId: l.householdId, isActive: true }, orderBy: { createdAt: 'asc' } }),
    pointBalances(l.householdId),
  ]);
  if (!members.length) return 'There are no members yet.';
  return `Points available: ${listWords(members.slice(0, 8).map((m) => `${m.displayName} has ${plural(balances.get(m.id)?.available ?? 0, 'point')}`))}.`;
}

async function notifications(l: Linked) {
  const rows = await prisma.notification.findMany({ where: { householdId: l.householdId, memberId: l.actor.memberId, readAt: null }, orderBy: { createdAt: 'desc' }, take: 20 });
  if (!rows.length) return 'You have no unread notifications.';
  const read = rows.slice(0, 5).map((n) => (n.type === 'summary.daily' ? (n.body ?? '').split('\n\n')[0] || n.title : `${n.title}${n.body ? `. ${n.body.slice(0, 200)}` : ''}`));
  return `You have ${plural(rows.length, 'unread notification')}. ${read.join('. ')}${rows.length > 5 ? `. And ${rows.length - 5} more` : ''}.`;
}

async function summary(l: Linked) {
  const s = await buildEveningSummary({ id: l.householdId, name: l.householdName, timezone: l.timezone });
  return s.body.split('\n\n')[0]!.replace(/^Good evening/, DateTime.now().setZone(l.timezone).hour < 17 ? 'Hello' : 'Good evening');
}

export async function handleAlexa(body: AlexaBody) {
  const type = body.request?.type;
  if (type === 'SessionEndedRequest') return { version: '1.0', response: {} };
  const l = await linkedFromToken(body.context?.System?.user?.accessToken ?? body.session?.user?.accessToken);
  if (!l) return linkAccount();
  if (type === 'LaunchRequest') return alexaSay(`Welcome to FamilyHub for ${l.householdName}. ${HELP}`, true);
  if (type !== 'IntentRequest') return alexaSay('Sorry, I cannot do that yet.');
  const intent = body.request?.intent;
  const slot = (n: string) => intent?.slots?.[n]?.value?.trim() || undefined;
  switch (intent?.name) {
    case 'AddTaskIntent': {
      const t = slot('task');
      return t ? alexaSay(await addTask(l, t)) : alexaSay('What task should I add?', true);
    }
    case 'AddToListIntent': {
      const item = slot('item');
      return item ? alexaSay(await addToList(l, item, slot('list'))) : alexaSay('What should I add?', true);
    }
    case 'AgendaIntent':
      return alexaSay(await agenda(l, slot('date')));
    case 'SummaryIntent':
      return alexaSay(await summary(l));
    case 'PointsIntent':
      return alexaSay(await points(l));
    case 'NotificationsIntent':
      return alexaSay(await notifications(l));
    case 'AMAZON.HelpIntent':
      return alexaSay(HELP, true);
    case 'AMAZON.StopIntent':
    case 'AMAZON.CancelIntent':
    case 'AMAZON.NavigateHomeIntent':
      return alexaSay('Goodbye.');
    default:
      return alexaSay(`Sorry, I did not get that. ${HELP}`, true);
  }
}

const tokenLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

/** Public OAuth and skill endpoints, mounted at /api/v1/alexa. */
export function alexaRouter() {
  const r = Router();

  r.post('/authorize', requireUser, wrap(async (req, res) => {
    if (!alexaConfigured()) throw unprocessable('ALEXA_NOT_CONFIGURED', 'Alexa is not set up on this server yet');
    const b = authorizeSchema.parse(req.body);
    if (!safeEqual(b.clientId, config.ALEXA_CLIENT_ID)) throw badRequest('Unknown Alexa client');
    if (!validAlexaRedirect(b.redirectUri)) throw badRequest('Invalid Alexa redirect address');
    const member = await activeMember(req.auth!.userId!, b.householdId);
    if (!member) throw notFound('Household');
    const code = randomToken(32);
    await prisma.alexaAuthCode.create({
      data: { codeHash: sha256(code), userId: req.auth!.userId!, householdId: b.householdId, redirectUri: b.redirectUri, codeChallenge: b.codeChallenge ?? null, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });
    await audit(req, { householdId: b.householdId, action: 'alexa.linked', entityType: 'member', entityId: member.id });
    const to = new URL(b.redirectUri);
    to.searchParams.set('state', b.state);
    to.searchParams.set('code', code);
    res.set('Cache-Control', 'no-store').json({ redirectTo: to.toString() });
  }));

  r.post('/token', tokenLimiter, express.urlencoded({ extended: false, limit: '16kb' }), wrap(async (req, res) => {
    if (!alexaConfigured()) return oauthError(res, 400, 'invalid_client');
    const cred = clientCredentials(req);
    if (!safeEqual(cred.id, config.ALEXA_CLIENT_ID) || !safeEqual(cred.secret, config.ALEXA_CLIENT_SECRET)) return oauthError(res, 401, 'invalid_client');
    const b = req.body as Record<string, string | undefined>;
    if (b.grant_type === 'authorization_code') {
      const row = b.code ? await prisma.alexaAuthCode.findUnique({ where: { codeHash: sha256(b.code) } }) : null;
      if (!row || row.usedAt || row.expiresAt < new Date() || (b.redirect_uri && b.redirect_uri !== row.redirectUri)) return oauthError(res, 400, 'invalid_grant');
      if (row.codeChallenge && (!b.code_verifier || createHash('sha256').update(b.code_verifier).digest('base64url') !== row.codeChallenge)) return oauthError(res, 400, 'invalid_grant');
      const used = await prisma.alexaAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count !== 1 || !(await activeMember(row.userId, row.householdId))) return oauthError(res, 400, 'invalid_grant');
      return res.set('Cache-Control', 'no-store').json(await issueTokens(null, { userId: row.userId, householdId: row.householdId }));
    }
    if (b.grant_type === 'refresh_token') {
      const g = b.refresh_token ? await prisma.alexaGrant.findUnique({ where: { refreshTokenHash: sha256(b.refresh_token) } }) : null;
      if (!g || g.revokedAt || !(await activeMember(g.userId, g.householdId))) return oauthError(res, 400, 'invalid_grant');
      return res.set('Cache-Control', 'no-store').json(await issueTokens(g.id, g));
    }
    return oauthError(res, 400, 'unsupported_grant_type');
  }));

  r.post('/skill', wrap(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    let body: AlexaBody;
    try {
      body = JSON.parse(raw.toString('utf8')) as AlexaBody;
    } catch {
      return res.status(400).end();
    }
    const skipVerify = config.NODE_ENV === 'test' && process.env.ALEXA_TEST_SKIP_VERIFY === '1';
    const ok = skipVerify || (await verifyAlexaRequest({ certUrl: req.get('SignatureCertChainUrl'), signature: req.get('Signature-256') }, raw, body.request?.timestamp));
    const appId = body.context?.System?.application?.applicationId ?? body.session?.application?.applicationId;
    if (!ok || (config.ALEXA_SKILL_ID && appId !== config.ALEXA_SKILL_ID)) return res.status(400).end();
    res.json(await handleAlexa(body));
  }));

  return r;
}

/** Household-scoped management of the caller's own Alexa links. */
export function alexaLinksRouter() {
  const r = Router({ mergeParams: true });
  r.use('/alexa', householdContext);
  r.get('/alexa', wrap(async (req, res) => {
    const c = ctx(req);
    const userId = c.actor.kind === 'member' ? c.actor.userId : null;
    const links = userId
      ? await prisma.alexaGrant.findMany({ where: { householdId: c.householdId, userId, revokedAt: null }, select: { id: true, createdAt: true, lastUsedAt: true }, orderBy: { createdAt: 'desc' } })
      : [];
    res.set('Cache-Control', 'private, no-store').json({ configured: alexaConfigured(), links });
  }));
  r.delete('/alexa/:grantId', wrap(async (req, res) => {
    const c = ctx(req);
    if (c.actor.kind !== 'member') throw notFound('Alexa link');
    const done = await prisma.alexaGrant.updateMany({ where: { id: req.params.grantId, householdId: c.householdId, userId: c.actor.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!done.count) throw notFound('Alexa link');
    await audit(req, { householdId: c.householdId, action: 'alexa.unlinked', entityType: 'member', entityId: c.actor.memberId });
    res.json({ ok: true });
  }));
  return r;
}
