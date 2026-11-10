import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticate, csrfProtection } from '../../src/auth/session.js';
import { prisma } from '../../src/db.js';
import { randomToken, sha256 } from '../../src/lib/crypto.js';
import { errorHandler, notFoundHandler } from '../../src/lib/errors.js';
import { deviceAlertsRouter } from '../../src/routes/deviceAlerts.js';
import { addMember, makeHousehold, resetDb } from './helpers.js';

const app = express();
app.use(express.json(), cookieParser(), authenticate, csrfProtection([]));
app.use('/api/v1/households/:householdId', deviceAlertsRouter());
app.use(notFoundHandler, errorHandler);

async function poster(userId: string) {
  const token = randomToken(32);
  await prisma.session.create({ data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86400000) } });
  return (householdId: string, body: object) =>
    request(app)
      .post(`/api/v1/households/${householdId}/device-alerts`)
      .set('Cookie', `fh_session=${token}; fh_csrf=t`)
      .set('x-csrf-token', 't')
      .send(body);
}

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('mirrored home-security app alerts', () => {
  it('adds one sanitized household-feed alert, dedupes repeats and rejects unknown apps or other homes', async () => {
    const { household, ownerUser } = await makeHousehold();
    const other = await makeHousehold();
    const post = await poster(ownerUser.id);
    expect((await post(household.id, { source: 'whatsapp', title: 'Hi' })).status).toBe(400);
    expect((await post(household.id, { source: 'ring', title: 'x', token: 'secret' })).status).toBe(400);
    const first = await post(household.id, { source: 'ring', title: 'Motion at Front Door\u0007', text: 'Someone is at the door' });
    expect(first.status).toBe(202);
    expect(first.body.accepted).toBe(true);
    expect((await post(household.id, { source: 'ring', title: 'Motion at Front Door', text: 'Someone is at the door' })).body.accepted).toBe(false);
    const feed = await prisma.notification.findMany({ where: { householdId: household.id, type: 'device.alert' } });
    expect(feed.length).toBeGreaterThan(0);
    expect(feed[0]!.title).toBe('Ring: Motion at Front Door');
    expect([403, 404]).toContain((await post(other.household.id, { source: 'myq', title: 'Garage opened' })).status);
  });

  it('ignores alerts posted by child or guest accounts', async () => {
    const { household } = await makeHousehold();
    const child = await addMember(household.id, 'CHILD', 'Kid');
    const post = await poster(child.user.id);
    expect((await post(household.id, { source: 'blink', title: 'Motion' })).body.accepted).toBe(false);
    expect(await prisma.notification.count({ where: { householdId: household.id, type: 'device.alert' } })).toBe(0);
  });
});
