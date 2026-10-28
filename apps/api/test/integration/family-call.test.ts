import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate, csrfProtection } from '../../src/auth/session.js';
import { hashSecret } from '../../src/auth/passwords.js';
import { prisma } from '../../src/db.js';
import { randomToken, sha256 } from '../../src/lib/crypto.js';
import { errorHandler, notFoundHandler } from '../../src/lib/errors.js';
import { realtime } from '../../src/lib/realtime.js';
import { familyCallRouter } from '../../src/routes/familyCall.js';
import { householdRouter } from '../../src/routes/households.js';
import { addMember, makeHousehold, resetDb } from './helpers.js';

// Use the production middleware without editing the central app registration.
const app = express();
app.use(express.json(), cookieParser(), authenticate, csrfProtection([]));
app.use('/api/v1/households/:householdId', familyCallRouter(), householdRouter());
app.use(notFoundHandler, errorHandler);
const path = (id: string) => `/api/v1/households/${id}/family-call`;
const voice = 'https://call.whatsapp.com/voice/test-token_123';
const video = 'https://call.whatsapp.com/video/another-token';

async function session(subject: { userId: string } | { deviceId: string; householdId: string }) {
  const token = randomToken(32);
  const row = await prisma.session.create({
    data: { ...subject, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86400000) },
  });
  const cookie = `fh_session=${token}; fh_csrf=call-test`;
  return {
    row,
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    patch: (url: string, body: object) =>
      request(app).patch(url).set('Cookie', cookie).set('x-csrf-token', 'call-test').send(body),
    unlock: (householdId: string) =>
      request(app)
        .post(`/api/v1/households/${householdId}/pin/verify`)
        .set('Cookie', cookie)
        .set('x-csrf-token', 'call-test')
        .send({ pin: '4321' }),
    cookie,
  };
}

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('household WhatsApp call links', () => {
  it('returns an empty state for a new household and lazily saves/clears only the call setting', async () => {
    const { household, ownerUser } = await makeHousehold();
    const actor = await session({ userId: ownerUser.id });
    const url = path(household.id);
    expect(
      await prisma.householdFeatureSettings.findUnique({ where: { householdId: household.id } }),
    ).toBeNull();
    const empty = await actor.get(url);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ whatsappCallUrl: null });
    expect(empty.headers['cache-control']).toBe('private, no-store');
    expect((await actor.patch(url, { whatsappCallUrl: voice })).body).toEqual({ whatsappCallUrl: voice });
    expect(
      await prisma.householdFeatureSettings.findUniqueOrThrow({ where: { householdId: household.id } }),
    ).toMatchObject({ dailySummaryEnabled: true, dailySummaryTime: '20:30' });
    await prisma.householdFeatureSettings.update({
      where: { householdId: household.id },
      data: { dailySummaryEnabled: false, dailySummaryTime: '19:15' },
    });
    expect((await actor.patch(url, { whatsappCallUrl: video })).body).toEqual({ whatsappCallUrl: video });
    expect((await actor.get(url)).body).toEqual({ whatsappCallUrl: video });
    expect((await actor.patch(url, { whatsappCallUrl: null })).body).toEqual({ whatsappCallUrl: null });
    expect((await actor.get(url)).body).toEqual({ whatsappCallUrl: null });
    expect(
      await prisma.householdFeatureSettings.findUnique({ where: { householdId: household.id } }),
    ).toMatchObject({ dailySummaryEnabled: false, dailySummaryTime: '19:15', whatsappCallUrl: null });
    expect((await prisma.household.findUniqueOrThrow({ where: { id: household.id } })).settings).toEqual(
      household.settings,
    );
    expect((await actor.patch(url, { whatsappCallUrl: null })).status).toBe(200);
  });

  it.each(['OWNER', 'ADULT_ADMIN', 'ADULT', 'CHILD', 'GUEST'] as const)(
    'allows %s to read but only owners/admins to save or clear',
    async (role) => {
      const { household, ownerUser } = await makeHousehold();
      await prisma.householdFeatureSettings.create({
        data: { householdId: household.id, whatsappCallUrl: voice },
      });
      const user = role === 'OWNER' ? ownerUser : (await addMember(household.id, role, role)).user;
      const actor = await session({ userId: user.id });
      expect((await actor.get(path(household.id))).body).toEqual({ whatsappCallUrl: voice });
      const status = role === 'OWNER' || role === 'ADULT_ADMIN' ? 200 : 403;
      expect((await actor.patch(path(household.id), { whatsappCallUrl: video })).status).toBe(status);
      expect((await actor.patch(path(household.id), { whatsappCallUrl: null })).status).toBe(status);
      expect((await actor.get(path(household.id))).body).toEqual({
        whatsappCallUrl: status === 200 ? null : voice,
      });
    },
  );

  it('requires a valid display PIN for editing, expires elevation and never switches a paired display home', async () => {
    const a = await makeHousehold();
    const b = await makeHousehold();
    await prisma.household.update({
      where: { id: a.household.id },
      data: { pinHash: await hashSecret('4321') },
    });
    await prisma.householdFeatureSettings.create({
      data: { householdId: b.household.id, whatsappCallUrl: video },
    });
    const device = await prisma.device.create({
      data: { householdId: a.household.id, name: 'Kitchen', pairedAt: new Date() },
    });
    const actor = await session({ deviceId: device.id, householdId: a.household.id });
    expect((await actor.get(path(a.household.id))).status).toBe(200);
    expect((await actor.patch(path(a.household.id), { whatsappCallUrl: voice })).status).toBe(403);
    expect((await actor.patch(path(a.household.id), { whatsappCallUrl: null })).status).toBe(403);
    expect((await actor.unlock(a.household.id)).status).toBe(200);
    expect((await actor.patch(path(a.household.id), { whatsappCallUrl: voice })).status).toBe(200);
    expect((await actor.get(path(a.household.id))).body).toEqual({ whatsappCallUrl: voice });
    expect((await actor.get(path(b.household.id))).status).toBe(404);
    expect((await actor.patch(path(b.household.id), { whatsappCallUrl: null })).status).toBe(404);
    expect((await actor.patch(path(a.household.id), { whatsappCallUrl: null })).status).toBe(200);
    await prisma.session.update({ where: { id: actor.row.id }, data: { pinElevatedUntil: new Date(0) } });
    expect((await actor.patch(path(a.household.id), { whatsappCallUrl: voice })).status).toBe(403);
    await prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    expect((await actor.get(path(a.household.id))).status).toBe(401);
    expect((await actor.patch(path(a.household.id), { whatsappCallUrl: voice })).status).toBe(401);
    expect(
      (await prisma.householdFeatureSettings.findUniqueOrThrow({ where: { householdId: b.household.id } }))
        .whatsappCallUrl,
    ).toBe(video);
  });

  it('isolates unrelated homes and applies the selected home role for multi-home members', async () => {
    const a = await makeHousehold();
    const b = await makeHousehold();
    const c = await makeHousehold();
    await prisma.householdFeatureSettings.createMany({
      data: [
        { householdId: a.household.id, whatsappCallUrl: voice },
        { householdId: b.household.id, whatsappCallUrl: video },
      ],
    });
    const actor = await session({ userId: a.ownerUser.id });
    expect((await actor.get(path(b.household.id))).status).toBe(404);
    expect((await actor.patch(path(b.household.id), { whatsappCallUrl: null })).status).toBe(404);
    await prisma.householdMember.create({
      data: {
        householdId: b.household.id,
        userId: a.ownerUser.id,
        role: 'ADULT',
        firstName: 'Parent',
        displayName: 'Parent',
        color: '#123456',
      },
    });
    expect((await actor.get(path(a.household.id))).body).toEqual({ whatsappCallUrl: voice });
    expect((await actor.get(path(b.household.id))).body).toEqual({ whatsappCallUrl: video });
    expect((await actor.patch(path(b.household.id), { whatsappCallUrl: null })).status).toBe(403);
    expect((await actor.get(path(c.household.id))).status).toBe(404);
    expect((await actor.get(path('not-a-household-id'))).status).toBe(404);
  });

  it('rejects unauthenticated, inactive and expired access, and enforces CSRF', async () => {
    const { household, ownerUser } = await makeHousehold();
    const url = path(household.id);
    expect((await request(app).get(url)).status).toBe(401);
    const actor = await session({ userId: ownerUser.id });
    expect(
      (await request(app).patch(url).set('Cookie', actor.cookie).send({ whatsappCallUrl: voice })).status,
    ).toBe(403);
    const guest = await addMember(household.id, 'GUEST', 'Guest');
    const guestSession = await session({ userId: guest.user.id });
    await prisma.householdMember.update({
      where: { id: guest.member.id },
      data: { accessExpiresAt: new Date(0) },
    });
    expect((await guestSession.get(url)).status).toBe(403);
    await prisma.householdMember.update({ where: { id: guest.member.id }, data: { isActive: false } });
    expect((await guestSession.get(url)).status).toBe(404);
    await prisma.session.update({ where: { id: actor.row.id }, data: { expiresAt: new Date(0) } });
    expect((await actor.get(url)).status).toBe(401);
  });

  it('strictly rejects malformed, redirected or malicious URLs and unexpected settings without changing the saved link', async () => {
    const { household, ownerUser } = await makeHousehold();
    const actor = await session({ userId: ownerUser.id });
    const url = path(household.id);
    await actor.patch(url, { whatsappCallUrl: voice });
    const invalid = [
      '',
      'https://call.whatsapp.com/voice/',
      'http://call.whatsapp.com/voice/abc',
      '//call.whatsapp.com/voice/abc',
      'javascript:alert(1)',
      'whatsapp://call/abc',
      'https://call.whatsapp.com.evil.example/voice/abc',
      'https://evil.example/voice/abc',
      'https://call.whatsapp.com@evil.example/voice/abc',
      'https://user:pass@call.whatsapp.com/voice/abc',
      'https://call.whatsapp.com:443/voice/abc',
      'https://call.whatsapp.com./voice/abc',
      'https://call.whatsapp.com/voice/abc?redirect=https://evil.example',
      'https://call.whatsapp.com/voice/abc#fragment',
      'https://call.whatsapp.com/voice/abc?',
      'https://call.whatsapp.com/video/abc#',
      'https://call.whatsapp.com/redirect/abc',
      'https://call.whatsapp.com/voice/abc/extra',
      'https://call.whatsapp.com/voice/../video/abc',
      'https://call.whatsapp.com/voice/%2fabc',
      'https://call.whatsapp.com/voice/abc\\evil',
      'https://call.whatsapp.com/voice/abc\n',
      ` ${voice}`,
      `${voice} `,
      'https://call.whatsapp.com/voice/a b',
      `https://call.whatsapp.com/voice/${'a'.repeat(501)}`,
      true,
      123,
    ];
    for (const whatsappCallUrl of invalid) {
      expect((await actor.patch(url, { whatsappCallUrl })).status, String(whatsappCallUrl)).toBe(400);
    }
    for (const body of [
      {},
      { whatsappCallUrl: video, householdId: 'other' },
      { whatsappCallUrl: video, dailySummaryEnabled: false },
    ]) {
      expect((await actor.patch(url, body)).status).toBe(400);
    }
    expect((await actor.get(url)).body).toEqual({ whatsappCallUrl: voice });
  });

  it('publishes only household-scoped invalidation and never stores the link in audit metadata or fetches it', async () => {
    const a = await makeHousehold();
    const b = await makeHousehold();
    const actor = await session({ userId: a.ownerUser.id });
    const changed = vi.fn();
    const other = vi.fn();
    const stopA = realtime.subscribe(a.household.id, changed);
    const stopB = realtime.subscribe(b.household.id, other);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network access forbidden'));
    try {
      expect((await actor.patch(path(a.household.id), { whatsappCallUrl: voice })).status).toBe(200);
      expect((await actor.patch(path(a.household.id), { whatsappCallUrl: null })).status).toBe(200);
      expect(fetch).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenCalledWith({ type: 'family-call.changed', at: expect.any(String) });
      expect(other).not.toHaveBeenCalled();
      const logs = await prisma.auditLog.findMany({
        where: { householdId: a.household.id, action: { startsWith: 'family-call.' } },
      });
      expect(logs.map((log) => log.action).sort()).toEqual(['family-call.cleared', 'family-call.updated']);
      expect(logs.every((log) => JSON.stringify(log.metadata) === '{}')).toBe(true);
      expect(JSON.stringify(logs)).not.toContain(voice);
    } finally {
      fetch.mockRestore();
      stopA();
      stopB();
    }
  });
});
