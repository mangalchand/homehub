import { Router } from 'express';
import { z } from 'zod';
import type { EmergencySession, Prisma } from '@prisma/client';
import { can, createEmergencySessionSchema, updateEmergencyLocationSchema, type Actor, type EmergencyLocation, type MemberRole } from '@familyhub/shared';
import { ctx, householdContext, type HouseholdContext } from '../auth/context.js';
import { prisma, type Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';

export const EMERGENCY_TTL_MS = 30 * 60_000;
export const EMERGENCY_FIX_MAX_AGE_MS = 2 * 60_000;
const UPDATE_INTERVAL_MS = 5_000;
const emptyLocation = { latitude: null, longitude: null, accuracyMeters: null, locationAt: null };
const include = { sourceMember: { select: { displayName: true } }, sourceDevice: { select: { name: true } } } satisfies Prisma.EmergencySessionInclude;
type Row = Prisma.EmergencySessionGetPayload<{ include: typeof include }>;

function originWhere(actor: Actor) {
  return actor.kind === 'member' ? { sourceMemberId: actor.memberId } : { sourceDeviceId: actor.deviceId };
}
function isOrigin(row: EmergencySession, actor: Actor) {
  return actor.kind === 'member' ? row.sourceMemberId === actor.memberId : row.sourceDeviceId === actor.deviceId;
}
function active(row: EmergencySession, now: Date) { return !row.stoppedAt && row.expiresAt > now; }
function dto(row: Row, actor: Actor, now = new Date()) {
  const ongoing = active(row, now);
  const fresh = ongoing && row.locationAt && now.getTime() - row.locationAt.getTime() <= EMERGENCY_FIX_MAX_AGE_MS;
  return {
    id: row.id, householdId: row.householdId, sourceMemberId: row.sourceMemberId, sourceDeviceId: row.sourceDeviceId,
    sender: row.sourceMember?.displayName ?? row.sourceDevice?.name ?? 'Household member',
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), stoppedAt: row.stoppedAt?.toISOString() ?? null,
    latitude: fresh ? row.latitude : null, longitude: fresh ? row.longitude : null, accuracyMeters: fresh ? row.accuracyMeters : null,
    locationAt: ongoing ? row.locationAt?.toISOString() ?? null : null,
    status: ongoing ? 'active' : row.stoppedAt ? 'stopped' : 'expired',
    locationStatus: !ongoing ? 'stopped' : !row.locationAt ? 'unavailable' : fresh ? 'live' : 'stale',
    isOrigin: isOrigin(row, actor), canStop: isOrigin(row, actor) || can(actor, 'members.manage'),
  };
}
function locationData(location: EmergencyLocation, now: Date) {
  const locationAt = new Date(location.locationAt);
  if (locationAt.getTime() < now.getTime() - EMERGENCY_FIX_MAX_AGE_MS || locationAt.getTime() > now.getTime() + 30_000) {
    throw badRequest('Location timestamp must be within the last two minutes and no more than 30 seconds ahead');
  }
  return { ...location, locationAt };
}
const changed = (householdId: string, id?: string) => realtime.publish(householdId, { type: 'safety.changed', ...(id ? { entityId: id } : {}) });

/** Run at least once per minute; safe to overlap across worker instances. Never emits location data. */
export async function cleanupExpiredEmergencySessions(now = new Date(), householdId?: string) {
  const rows = await prisma.emergencySession.findMany({
    where: { ...(householdId ? { householdId } : {}), latitude: { not: null }, OR: [{ expiresAt: { lte: now } }, { stoppedAt: { not: null } }] },
    select: { id: true, householdId: true },
  });
  const result = await prisma.emergencySession.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, OR: [{ expiresAt: { lte: now } }, { stoppedAt: { not: null } }] },
    data: emptyLocation,
  });
  for (const hid of new Set(rows.map((r) => r.householdId))) changed(hid);
  return result.count;
}

/** Lock the actor, not a process-local mutex: dedupe and start limits work across API instances. */
async function lockActor(tx: Tx, c: HouseholdContext) {
  if (c.actor.kind === 'member') {
    const rows = await tx.$queryRaw<{ id: string; role: MemberRole }[]>`SELECT id, role FROM household_members WHERE id = ${c.actor.memberId}::uuid AND household_id = ${c.householdId}::uuid AND is_active = true AND (access_expires_at IS NULL OR access_expires_at > NOW()) FOR UPDATE`;
    if (!rows.length) throw notFound('Household');
    c.actor.role = rows[0]!.role;
  } else {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM devices WHERE id = ${c.actor.deviceId}::uuid AND household_id = ${c.householdId}::uuid AND revoked_at IS NULL AND paired_at IS NOT NULL FOR UPDATE`;
    if (!rows.length) throw notFound('Household');
  }
}

export function safetyRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  router.use(async (req, _res, next) => {
    try {
      const c = ctx(req);
      if (c.actor.kind === 'device' && !await prisma.device.findFirst({ where: { id: c.actor.deviceId, householdId: c.householdId, revokedAt: null, pairedAt: { not: null } }, select: { id: true } })) throw notFound('Household');
      next();
    } catch (err) { next(err); }
  });
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store, private'); next(); });
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };
  const id = (value: string | undefined) => { if (!z.string().uuid().safeParse(value).success) throw notFound('Alert'); return value!; };

  route(m, { method: 'get', path: '/safety', summary: 'Current household alerts and recently ended alerts (no ended coordinates)', tags: ['Safety'] }, async (req) => {
    const c = ctx(req);
    await cleanupExpiredEmergencySessions(new Date(), c.householdId);
    const rows = await prisma.emergencySession.findMany({
      where: { householdId: c.householdId, OR: [{ stoppedAt: null, expiresAt: { gt: new Date() } }, { updatedAt: { gt: new Date(Date.now() - 60 * 60_000) } }] },
      orderBy: { createdAt: 'desc' }, include,
    });
    return { sessions: rows.map((row) => dto(row, c.actor)), serverTime: new Date().toISOString() };
  });

  route(m, { method: 'post', path: '/safety', summary: 'Immediately start an SOS, with optional location; retries return the active SOS', tags: ['Safety'], body: createEmergencySessionSchema }, async (req, res, { body }) => {
    const c = ctx(req);
    const result = await prisma.$transaction(async (tx) => {
      await lockActor(tx, c);
      const now = new Date();
      const where = { householdId: c.householdId, ...originWhere(c.actor) };
      const existing = await tx.emergencySession.findFirst({ where: { ...where, stoppedAt: null, expiresAt: { gt: now } }, include });
      if (existing) return { row: existing, created: false };
      if (await tx.emergencySession.count({ where: { ...where, createdAt: { gt: new Date(now.getTime() - 10 * 60_000) } } }) >= 6) {
        throw new AppError(429, 'RATE_LIMITED', 'Too many new alerts. Please wait before starting another; contact emergency services directly if needed.');
      }
      const row = await tx.emergencySession.create({ data: { ...where, expiresAt: new Date(now.getTime() + EMERGENCY_TTL_MS), ...(body.location ? locationData(body.location, now) : {}) }, include });
      return { row, created: true };
    });
    if (result.created) {
      changed(c.householdId, result.row.id);
      void audit(req, { householdId: c.householdId, action: 'safety.started', entityType: 'EmergencySession', entityId: result.row.id });
      // Persist and fan out after activation; never wait for GPS or external delivery.
      void notify(c.householdId, { type: 'safety.started', title: 'Household SOS alert', body: 'Someone in your household needs help. Open Safety to view the active alert. Not monitored emergency dispatch; delivery is not guaranteed.', url: `/safety?householdId=${encodeURIComponent(c.householdId)}`, data: { emergencySessionId: result.row.id }, householdFeed: true }, { dedupeKey: `safety:${result.row.id}` });
    }
    res.status(result.created ? 201 : 200).json(dto(result.row, c.actor));
  });

  route(m, { method: 'patch', path: '/safety/:sessionId/location', summary: 'Originating actor only: replace the latest live location', tags: ['Safety'], body: updateEmergencyLocationSchema }, async (req, _res, { body }) => {
    const c = ctx(req);
    const sessionId = id(req.params.sessionId);
    const row = await prisma.$transaction(async (tx) => {
      await lockActor(tx, c);
      const now = new Date();
      const current = await tx.emergencySession.findFirst({ where: { householdId: c.householdId, id: sessionId } });
      if (!current) throw notFound('Alert');
      if (!isOrigin(current, c.actor)) throw forbidden('Only the originating member or display can share its location');
      if (!active(current, now)) throw conflict('This alert has ended');
      const fix = locationData(body, now);
      if (current.locationAt && fix.locationAt <= current.locationAt) throw conflict('A newer location has already been received');
      if (current.locationAt && current.updatedAt.getTime() > now.getTime() - UPDATE_INTERVAL_MS) throw new AppError(429, 'RATE_LIMITED', 'Send location updates at most once every five seconds');
      const updated = await tx.emergencySession.updateMany({
        where: { householdId: c.householdId, id: sessionId, stoppedAt: null, expiresAt: { gt: now }, OR: [{ locationAt: null }, { locationAt: { lt: fix.locationAt } }] }, data: fix,
      });
      if (!updated.count) throw conflict('This alert ended or a newer location was received');
      return tx.emergencySession.findUniqueOrThrow({ where: { id: sessionId }, include });
    });
    changed(c.householdId, row.id);
    return dto(row, c.actor);
  });

  route(m, { method: 'post', path: '/safety/:sessionId/stop', summary: 'End an SOS and erase its latest location', tags: ['Safety'], body: z.object({}).strict() }, async (req) => {
    const c = ctx(req);
    const sessionId = id(req.params.sessionId);
    const row = await prisma.$transaction(async (tx) => {
      await lockActor(tx, c);
      const current = await tx.emergencySession.findFirst({ where: { householdId: c.householdId, id: sessionId } });
      if (!current) throw notFound('Alert');
      if (!isOrigin(current, c.actor) && !can(c.actor, 'members.manage')) throw forbidden('Only the originating actor, a parent/admin, or PIN-unlocked display can stop this alert');
      await tx.emergencySession.updateMany({ where: { householdId: c.householdId, id: sessionId, stoppedAt: null }, data: { stoppedAt: new Date(), ...emptyLocation } });
      return tx.emergencySession.findUniqueOrThrow({ where: { id: sessionId }, include });
    });
    changed(c.householdId, row.id);
    void audit(req, { householdId: c.householdId, action: 'safety.stopped', entityType: 'EmergencySession', entityId: row.id });
    return dto(row, c.actor);
  });
  return router;
}
