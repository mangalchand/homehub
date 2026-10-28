import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { authenticate, csrfProtection } from '../../src/auth/session.js';
import { randomToken, sha256 } from '../../src/lib/crypto.js';
import { errorHandler } from '../../src/lib/errors.js';
import { summariesRouter } from '../../src/routes/summaries.js';
import { addMember, makeHousehold, resetDb } from './helpers.js';

const app = express();
app.use(express.json(), cookieParser(), authenticate, csrfProtection([]));
app.use('/api/v1/households/:householdId', summariesRouter());
app.use(errorHandler);
beforeEach(() => resetDb());
afterAll(() => prisma.$disconnect());

async function session(householdId: string, subject: { userId: string } | { deviceId: string }, elevated = false) {
  const token = randomToken(32);
  await prisma.session.create({ data: { householdId, ...subject, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86400000), pinElevatedUntil: elevated ? new Date(Date.now() + 300000) : null } });
  const cookie = `fh_session=${token}; fh_csrf=summary-csrf`;
  return {
    get: (path: string, hid = householdId) => request(app).get(`/api/v1/households/${hid}${path}`).set('Cookie', cookie),
    patch: (body: object, hid = householdId) => request(app).patch(`/api/v1/households/${hid}/summaries/settings`).set('Cookie', cookie).set('x-csrf-token', 'summary-csrf').send(body),
  };
}

describe('summary API authorization, schedules and history', () => {
  it('allows owner/admin edits, leaves adult/child/guest read-only, and preserves unrelated settings and timezone', async () => {
    const { household, ownerUser } = await makeHousehold();
    const owner = await session(household.id, { userId: ownerUser.id });
    const defaults = await owner.get('/summaries/settings');
    expect(defaults.status).toBe(200);
    expect(defaults.body).toMatchObject({ dailySummaryEnabled: true, dailySummaryTime: '20:30', timezone: 'America/New_York', canManage: true });
    await prisma.householdFeatureSettings.update({ where: { householdId: household.id }, data: { whatsappCallUrl: 'https://call.whatsapp.com/voice/testlink' } });
    expect((await owner.patch({ dailySummaryTime: '21:15' })).status).toBe(200);
    const admin = await addMember(household.id, 'ADULT_ADMIN', 'Admin');
    expect((await (await session(household.id, { userId: admin.user.id })).patch({ dailySummaryEnabled: false })).status).toBe(200);
    const saved = await prisma.householdFeatureSettings.findUniqueOrThrow({ where: { householdId: household.id } });
    expect(saved).toMatchObject({ dailySummaryEnabled: false, dailySummaryTime: '21:15', whatsappCallUrl: 'https://call.whatsapp.com/voice/testlink' });
    expect((await prisma.household.findUniqueOrThrow({ where: { id: household.id } })).timezone).toBe(household.timezone);
    for (const role of ['ADULT', 'CHILD', 'GUEST'] as const) {
      const member = await addMember(household.id, role, role);
      const client = await session(household.id, { userId: member.user.id });
      expect((await client.get('/summaries/settings')).body.canManage).toBe(false);
      expect((await client.get('/summaries/preview')).status).toBe(200);
      expect((await client.get('/summaries')).status).toBe(200);
      expect((await client.patch({ dailySummaryEnabled: true })).status).toBe(403);
    }
  });

  it('requires current PIN elevation on displays and binds devices/members to the authorized household', async () => {
    const { household, ownerUser } = await makeHousehold();
    const other = await makeHousehold();
    const device = await prisma.device.create({ data: { householdId: household.id, name: 'Kitchen' } });
    const locked = await session(household.id, { deviceId: device.id });
    const unlocked = await session(household.id, { deviceId: device.id }, true);
    expect((await locked.get('/summaries/settings')).body.canManage).toBe(false);
    expect((await locked.patch({ dailySummaryEnabled: false })).status).toBe(403);
    expect((await unlocked.patch({ dailySummaryEnabled: false })).status).toBe(200);
    expect((await unlocked.get('/summaries/preview', other.household.id)).status).toBe(404);
    expect((await unlocked.patch({ dailySummaryEnabled: true }, other.household.id)).status).toBe(404);
    const owner = await session(household.id, { userId: ownerUser.id });
    expect((await owner.get('/summaries', other.household.id)).status).toBe(404);
    await prisma.session.updateMany({ where: { deviceId: device.id }, data: { pinElevatedUntil: new Date(Date.now() - 1) } });
    expect((await unlocked.patch({ dailySummaryEnabled: true })).status).toBe(403);
    await prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    expect((await unlocked.get('/summaries')).status).toBe(401);
  });

  it('rejects unauthenticated, expired, deactivated and unverified callers, and enforces CSRF', async () => {
    const { household, ownerUser, ownerMember } = await makeHousehold();
    expect((await request(app).get(`/api/v1/households/${household.id}/summaries`)).status).toBe(401);
    const client = await session(household.id, { userId: ownerUser.id });
    expect((await request(app).patch(`/api/v1/households/${household.id}/summaries/settings`).send({ dailySummaryEnabled: false })).status).toBe(403);
    await prisma.householdMember.update({ where: { id: ownerMember.id }, data: { accessExpiresAt: new Date(Date.now() - 1) } });
    expect((await client.get('/summaries')).status).toBe(403);
    await prisma.householdMember.update({ where: { id: ownerMember.id }, data: { accessExpiresAt: null, isActive: false } });
    expect((await client.get('/summaries')).status).toBe(404);
    await prisma.householdMember.update({ where: { id: ownerMember.id }, data: { isActive: true } });
    await prisma.user.update({ where: { id: ownerUser.id }, data: { emailVerifiedAt: null } });
    expect((await client.get('/summaries')).status).toBe(403);
  });

  it('validates strict times and only accepts the two summary-specific patch fields', async () => {
    const { household, ownerUser } = await makeHousehold();
    const owner = await session(household.id, { userId: ownerUser.id });
    for (const body of [{ dailySummaryTime: '24:00' }, { dailySummaryTime: '8:30' }, { dailySummaryTime: '20:60' }, { dailySummaryEnabled: 'false' }, { timezone: 'UTC' }, { whatsappCallUrl: null }]) {
      expect((await owner.patch(body)).status).toBe(400);
    }
    expect((await owner.patch({ dailySummaryTime: '00:00' })).status).toBe(200);
    expect((await owner.patch({})).status).toBe(200);
  });

  it('returns tenant-scoped paginated saved snapshots without tokens/internal errors, and preview never delivers', async () => {
    const { household, ownerUser } = await makeHousehold();
    const other = await makeHousehold();
    const owner = await session(household.id, { userId: ownerUser.id });
    const payload = { title: 'Saved snapshot', body: 'Original readable body', generatedAt: new Date().toISOString() };
    await prisma.dailySummaryRun.createMany({ data: [
      { householdId: household.id, localDate: new Date('2026-10-27'), status: 'CLAIMED', claimedAt: new Date(), leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(Date.now() + 300000), payload, lastError: 'private diagnostic' },
      { householdId: household.id, localDate: new Date('2026-10-26'), status: 'SENT', sentAt: new Date(), payload },
      { householdId: other.household.id, localDate: new Date('2026-10-27'), status: 'FAILED', lastError: 'other household' },
    ] });
    const first = await owner.get('/summaries?limit=1');
    expect(first.status).toBe(200);
    expect(first.body.runs).toHaveLength(1);
    expect(first.body.nextBefore).toBe('2026-10-27');
    expect(first.body.runs[0].payload).toEqual(payload);
    expect(first.body.runs[0]).not.toHaveProperty('leaseToken');
    expect(first.body.runs[0]).not.toHaveProperty('lastError');
    const next = await owner.get('/summaries?limit=1&before=2026-10-27');
    expect(next.body.runs[0].localDate).toBe('2026-10-26');
    expect(next.body.nextBefore).toBeNull();
    expect((await owner.get('/summaries?limit=500')).status).toBe(400);
    expect((await owner.get('/summaries?before=bad')).status).toBe(400);
    const preview = await owner.get('/summaries/preview');
    expect(preview.status).toBe(200);
    expect(preview.body.payload.body).toContain('Points totals');
    expect(preview.body.timezone).toBe(household.timezone);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.dailySummaryRun.count()).toBe(3);
    expect(first.body.deliveryNote).toContain('best-effort');
  });
});
