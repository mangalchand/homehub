import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { authenticate, csrfProtection } from '../../src/auth/session.js';
import { errorHandler } from '../../src/lib/errors.js';
import { randomToken, sha256 } from '../../src/lib/crypto.js';
import { notify } from '../../src/lib/notify.js';
import { realtime } from '../../src/lib/realtime.js';
import { cleanupExpiredEmergencySessions, EMERGENCY_TTL_MS, safetyRouter } from '../../src/routes/safety.js';
import { addMember, makeHousehold, resetDb } from './helpers.js';

vi.mock('../../src/lib/notify.js', () => ({ notify: vi.fn().mockResolvedValue(1) }));
const app = express();
app.use(express.json(), cookieParser(), authenticate, csrfProtection([]));
app.use('/api/v1/households/:householdId', safetyRouter());
app.use(errorHandler);
const secondApp = express();
secondApp.use(express.json(), cookieParser(), authenticate, csrfProtection([]));
secondApp.use('/api/v1/households/:householdId', safetyRouter());
secondApp.use(errorHandler);
beforeEach(async () => { await resetDb(); vi.mocked(notify).mockClear(); });
afterAll(() => prisma.$disconnect());
const base = (hid: string) => `/api/v1/households/${hid}/safety`;
const fix = (extra: object = {}) => ({ latitude: 10.125, longitude: -20.25, accuracyMeters: 12, locationAt: new Date().toISOString(), ...extra });
async function caller(subject: { userId: string } | { deviceId: string; householdId: string }, elevated = false, target = app) {
  const token = randomToken(32);
  await prisma.session.create({ data: { ...subject, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86_400_000), pinElevatedUntil: elevated ? new Date(Date.now() + 60_000) : null } });
  const cookie = `fh_session=${token}; fh_csrf=safety-test`;
  return {
    get: (url: string) => request(target).get(url).set('Cookie', cookie),
    post: (url: string, body: object = {}) => request(target).post(url).set('Cookie', cookie).set('x-csrf-token', 'safety-test').send(body),
    patch: (url: string, body: object = {}) => request(target).patch(url).set('Cookie', cookie).set('x-csrf-token', 'safety-test').send(body),
  };
}
async function setup() {
  const h = await makeHousehold();
  const owner = await caller({ userId: h.ownerUser.id });
  return { ...h, owner, path: base(h.household.id) };
}

describe('household safety authorization and privacy', () => {
  it('does not apply safety authorization or cache headers to neighboring household routes', async () => {
    const adjacent = express();
    adjacent.use('/api/v1/households/:householdId', safetyRouter());
    adjacent.get('/api/v1/households/:householdId/neighbor', (_req, res) => res.sendStatus(204));
    adjacent.use(errorHandler);
    const response = await request(adjacent).get(`/api/v1/households/${crypto.randomUUID()}/neighbor`);
    expect(response.status).toBe(204);
    expect(response.headers['cache-control']).toBeUndefined();
  });

  it('activates without GPS immediately, scopes identity/expiry, publishes only invalidation and safe notification content', async () => {
    const h = await setup();
    const messages: unknown[] = [];
    const off = realtime.subscribe(h.household.id, (m) => messages.push(m));
    try {
      const response = await h.owner.post(h.path);
      expect(response.status).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.body).toMatchObject({ sourceMemberId: h.ownerMember.id, sourceDeviceId: null, status: 'active', latitude: null, locationStatus: 'unavailable', isOrigin: true, canStop: true });
      expect(Date.parse(response.body.expiresAt) - Date.parse(response.body.createdAt)).toBeCloseTo(EMERGENCY_TTL_MS, -2);
      expect(messages).toEqual([expect.objectContaining({ type: 'safety.changed', entityId: response.body.id })]);
      expect(notify).toHaveBeenCalledWith(h.household.id, expect.objectContaining({ type: 'safety.started', householdFeed: true, url: `/safety?householdId=${h.household.id}` }), expect.any(Object));
      expect(JSON.stringify(vi.mocked(notify).mock.calls)).not.toMatch(/latitude|longitude|accuracy|locationAt/);
      expect((await h.owner.get(h.path)).body.sessions).toHaveLength(1);
      await vi.waitFor(async () => expect(await prisma.auditLog.count({ where: { action: 'safety.started' } })).toBe(1));
      expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'safety.started' } })).metadata).toEqual({});
    } finally { off(); }
  });

  it('deduplicates concurrent starts atomically across independently constructed routers and never extends expiry', async () => {
    const h = await setup();
    const second = await caller({ userId: h.ownerUser.id }, false, secondApp);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? second : h.owner).post(h.path)));
    expect(responses.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    expect(responses.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(new Set(responses.map((r) => r.body.expiresAt)).size).toBe(1);
    expect(await prisma.emergencySession.count()).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('denies unauthenticated/CSRF writes and rejects actor, household and expiry spoofing', async () => {
    const h = await setup();
    expect((await request(app).get(h.path)).status).toBe(401);
    expect((await request(app).post(h.path).send({})).status).toBe(403);
    for (const body of [{ sourceMemberId: h.ownerMember.id }, { sourceDeviceId: crypto.randomUUID() }, { householdId: h.household.id }, { expiresAt: new Date().toISOString() }]) {
      expect((await h.owner.post(h.path, body)).status).toBe(400);
    }
    expect(await prisma.emergencySession.count()).toBe(0);
  });

  it('prevents cross-home reads and writes even if a user belongs to both homes and knows the alert id', async () => {
    const h = await setup();
    const other = await makeHousehold('Other');
    const otherOwner = await caller({ userId: other.ownerUser.id });
    const alert = (await h.owner.post(h.path)).body;
    expect((await otherOwner.get(h.path)).status).toBe(404);
    expect((await otherOwner.patch(`${h.path}/${alert.id}/location`, fix())).status).toBe(404);
    expect((await otherOwner.post(`${h.path}/${alert.id}/stop`)).status).toBe(404);
    await prisma.householdMember.create({ data: { householdId: other.household.id, userId: h.ownerUser.id, role: 'OWNER', firstName: 'Owner', displayName: 'Owner' } });
    expect((await h.owner.patch(`${base(other.household.id)}/${alert.id}/location`, fix())).status).toBe(404);
    expect((await h.owner.post(`${base(other.household.id)}/${alert.id}/stop`)).status).toBe(404);
    expect((await h.owner.get(base(other.household.id))).body.sessions).toEqual([]);
  });

  it('permits all active personal roles to start but only origin or parent/admin to stop; not even admins can spoof location', async () => {
    const h = await setup();
    const child = await addMember(h.household.id, 'CHILD', 'Child');
    const adult = await addMember(h.household.id, 'ADULT', 'Adult');
    const admin = await addMember(h.household.id, 'ADULT_ADMIN', 'Parent');
    const guest = await addMember(h.household.id, 'GUEST', 'Guest');
    const c = await caller({ userId: child.user.id });
    const a = await caller({ userId: adult.user.id });
    const p = await caller({ userId: admin.user.id });
    const g = await caller({ userId: guest.user.id });
    for (const actor of [a, g]) expect((await actor.post(h.path)).status).toBe(201);
    const alert = await c.post(h.path);
    expect(alert.status).toBe(201);
    expect((await a.post(`${h.path}/${alert.body.id}/stop`)).status).toBe(403);
    expect((await g.post(`${h.path}/${alert.body.id}/stop`)).status).toBe(403);
    for (const actor of [a, p, h.owner]) expect((await actor.patch(`${h.path}/${alert.body.id}/location`, fix())).status).toBe(403);
    expect((await p.post(`${h.path}/${alert.body.id}/stop`)).status).toBe(200);
    const next = await c.post(h.path);
    expect((await c.post(`${h.path}/${next.body.id}/stop`)).status).toBe(200);
  });

  it('denies revoked/expired membership and revoked/unpaired devices, and binds paired displays to one home', async () => {
    const h = await setup();
    const other = await makeHousehold();
    const guest = await addMember(h.household.id, 'GUEST', 'Guest');
    const g = await caller({ userId: guest.user.id });
    const alert = (await g.post(h.path)).body;
    await prisma.householdMember.update({ where: { id: guest.member.id }, data: { isActive: false } });
    expect((await g.get(h.path)).status).toBe(404);
    expect((await g.post(h.path)).status).toBe(404);
    expect((await g.patch(`${h.path}/${alert.id}/location`, fix())).status).toBe(404);
    expect((await g.post(`${h.path}/${alert.id}/stop`)).status).toBe(404);
    await prisma.householdMember.update({ where: { id: guest.member.id }, data: { isActive: true, accessExpiresAt: new Date(Date.now() - 1000) } });
    expect((await g.get(h.path)).status).toBe(403);
    const device = await prisma.device.create({ data: { householdId: h.household.id, name: 'Kitchen', pairedAt: new Date() } });
    const d = await caller({ deviceId: device.id, householdId: h.household.id });
    expect((await d.get(base(other.household.id))).status).toBe(404);
    const started = await d.post(h.path);
    expect(started.body.sourceDeviceId).toBe(device.id);
    expect((await d.patch(`${h.path}/${started.body.id}/location`, fix())).status).toBe(200);
    expect((await d.post(`${h.path}/${alert.id}/stop`)).status).toBe(403);
    const elevated = await caller({ deviceId: device.id, householdId: h.household.id }, true);
    expect((await elevated.post(`${h.path}/${alert.id}/stop`)).status).toBe(200);
    expect((await d.post(`${h.path}/${started.body.id}/stop`)).status).toBe(200);
    await prisma.device.update({ where: { id: device.id }, data: { pairedAt: null } });
    expect((await d.get(h.path)).status).toBe(404);
    await prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    expect((await d.get(h.path)).status).toBe(401);
    expect((await d.post(h.path)).status).toBe(401);
  });

  it('validates fixes and timestamps, rate limits, rejects older fixes and retains only a latest point', async () => {
    const h = await setup();
    const alert = (await h.owner.post(h.path)).body;
    const path = `${h.path}/${alert.id}/location`;
    for (const invalid of [{ latitude: 91 }, { longitude: -181 }, { accuracyMeters: -1 }, { locationAt: new Date(Date.now() - 180_000).toISOString() }, { locationAt: new Date(Date.now() + 60_000).toISOString() }, { sourceMemberId: h.ownerMember.id }]) expect((await h.owner.patch(path, fix(invalid))).status).toBe(400);
    const firstFix = fix({ locationAt: new Date(Date.now() - 10_000).toISOString() });
    expect((await h.owner.patch(path, firstFix)).status).toBe(200);
    expect((await h.owner.patch(path, fix())).status).toBe(429);
    expect((await h.owner.patch(path, firstFix)).status).toBe(409);
    await prisma.emergencySession.update({ where: { id: alert.id }, data: { updatedAt: new Date(Date.now() - 6000) } });
    const second = await h.owner.patch(path, fix({ latitude: 11 }));
    expect(second.status).toBe(200);
    expect(second.body.latitude).toBe(11);
    expect(await prisma.emergencySession.count()).toBe(1);
    const raw = await prisma.emergencySession.findUniqueOrThrow({ where: { id: alert.id } });
    expect(raw.latitude).toBe(11);
  });

  it('never returns stale or ended coordinates and permanently clears the point on stop/expiry', async () => {
    const h = await setup();
    const alert = (await h.owner.post(h.path, { location: fix() })).body;
    await prisma.emergencySession.update({ where: { id: alert.id }, data: { locationAt: new Date(Date.now() - 180_000) } });
    const stale = (await h.owner.get(h.path)).body.sessions[0];
    expect(stale).toMatchObject({ locationStatus: 'stale', latitude: null, longitude: null, accuracyMeters: null });
    const stopped = await h.owner.post(`${h.path}/${alert.id}/stop`);
    expect(stopped.body).toMatchObject({ status: 'stopped', locationStatus: 'stopped', latitude: null, longitude: null, locationAt: null });
    expect((await prisma.emergencySession.findUniqueOrThrow({ where: { id: alert.id } })).latitude).toBeNull();
    expect((await h.owner.patch(`${h.path}/${alert.id}/location`, fix())).status).toBe(409);
    const expired = await prisma.emergencySession.create({ data: { householdId: h.household.id, sourceMemberId: h.ownerMember.id, createdAt: new Date(Date.now() - 2 * EMERGENCY_TTL_MS), expiresAt: new Date(Date.now() - 1000), ...fix(), locationAt: new Date() } });
    expect((await h.owner.get(h.path)).body.sessions.find((s: { id: string }) => s.id === expired.id)).toMatchObject({ status: 'expired', latitude: null, longitude: null, locationAt: null });
    expect((await prisma.emergencySession.findUniqueOrThrow({ where: { id: expired.id } })).latitude).toBeNull();
    expect((await h.owner.patch(`${h.path}/${expired.id}/location`, fix())).status).toBe(409);
    expect(await cleanupExpiredEmergencySessions()).toBe(0);
  });

  it('cleanup erases expired/stopped locations, never touches another active alert, and is safe to repeat', async () => {
    const h = await setup();
    const alert = (await h.owner.post(h.path, { location: fix() })).body;
    await prisma.emergencySession.update({ where: { id: alert.id }, data: { createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 1000) } });
    const other = await makeHousehold();
    const otherAlert = await prisma.emergencySession.create({ data: { householdId: other.household.id, sourceMemberId: other.ownerMember.id, expiresAt: new Date(Date.now() + 60_000), ...fix(), locationAt: new Date() } });
    expect(await cleanupExpiredEmergencySessions()).toBe(1);
    expect(await cleanupExpiredEmergencySessions()).toBe(0);
    expect((await prisma.emergencySession.findUniqueOrThrow({ where: { id: otherAlert.id } })).latitude).not.toBeNull();
  });

  it('limits repeated new starts without limiting retries of a currently active emergency', async () => {
    const h = await setup();
    for (let i = 0; i < 6; i++) {
      const alert = await h.owner.post(h.path);
      expect(alert.status).toBe(201);
      expect((await h.owner.post(h.path)).status).toBe(200);
      expect((await h.owner.post(`${h.path}/${alert.body.id}/stop`)).status).toBe(200);
    }
    expect((await h.owner.post(h.path)).status).toBe(429);
  });
});
