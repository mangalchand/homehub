import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { randomToken, sha256 } from '../../src/lib/crypto.js';
import { notify } from '../../src/lib/notify.js';
import { sendFcm } from '../../src/lib/fcm.js';
import { app, login, makeHousehold, resetDb } from './helpers.js';

vi.mock('../../src/lib/fcm.js', () => ({ fcmConfigured: () => true, sendFcm: vi.fn().mockResolvedValue(true) }));
beforeEach(async () => { await resetDb(); vi.mocked(sendFcm).mockClear(); });
afterAll(() => prisma.$disconnect());

async function tablet(householdId: string) {
  const device = await prisma.device.create({ data: { householdId, name: 'Kitchen', pairedAt: new Date() } });
  const token = randomToken(32);
  await prisma.session.create({ data: { tokenHash: sha256(token), deviceId: device.id, householdId, expiresAt: new Date(Date.now() + 86400000) } });
  const cookie = `fh_session=${token}; fh_csrf=testcsrf`;
  const base = `/api/v1/households/${householdId}`;
  return {
    device, base,
    get: (path: string) => request(app).get(base + path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => request(app).post(base + path).set('Cookie', cookie).set('x-csrf-token', 'testcsrf').send(body),
  };
}

describe('paired tablet notifications', () => {
  it('gets each new list and item; read state is independent on each device', async () => {
    const { household, ownerUser } = await makeHousehold();
    const owner = await login(ownerUser.email);
    const a = await tablet(household.id);
    const b = await tablet(household.id);
    expect((await a.get('/notifications')).body).toEqual([]);
    const list = await owner.post(`${a.base}/lists`, { name: 'Shopping', type: 'GROCERY' });
    const first = crypto.randomUUID();
    for (const [id, name] of [[first, 'Milk'], [crypto.randomUUID(), 'Eggs']]) {
      expect((await owner.post(`${a.base}/lists/${list.body.id}/items`, { id, name })).status).toBe(201);
    }
    // Retry of the same offline mutation must not notify twice.
    await owner.post(`${a.base}/lists/${list.body.id}/items`, { id: first, name: 'Milk' });
    const feed = (await a.get('/notifications')).body as { id: string; body: string; readAt: string | null }[];
    expect(feed).toHaveLength(3);
    expect(feed.map((n) => n.body)).toEqual(expect.arrayContaining(['Milk', 'Eggs']));
    expect(feed.every((n) => !n.readAt)).toBe(true);
    await a.post('/notifications/read', { ids: [feed[0]!.id] });
    expect((await a.get('/notifications')).body.filter((n: { readAt: string | null }) => n.readAt)).toHaveLength(1);
    expect((await b.get('/notifications')).body.every((n: { readAt: string | null }) => !n.readAt)).toBe(true);
    await a.post('/notifications/read');
    expect((await a.get('/notifications')).body.every((n: { readAt: string | null }) => n.readAt)).toBe(true);
  });

  it('does not expose private member alerts or another household feed', async () => {
    const { household, ownerMember } = await makeHousehold();
    const other = await makeHousehold();
    const t = await tablet(household.id);
    await notify(household.id, { type: 'join.requested', title: 'Admin only', external: false }, { to: [ownerMember.id] });
    await notify(other.household.id, { type: 'list.created', title: 'Other home', external: false });
    expect((await t.get('/notifications')).body).toEqual([]);
  });

  it('registers tablet FCM tokens and pushes household alerts but not private alerts or to revoked devices', async () => {
    const { household, ownerMember } = await makeHousehold();
    const t = await tablet(household.id);
    const token = 'test-fcm-token-for-tablet-12345';
    expect((await t.post('/push/fcm-token', { token })).status).toBe(201);
    const sub = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: token } });
    expect(sub.deviceId).toBe(t.device.id);
    expect(sub.memberId).toBeNull();
    await notify(household.id, { type: 'list.item_added', title: 'Added milk' });
    await vi.waitFor(() => expect(sendFcm).toHaveBeenCalledWith(token, expect.objectContaining({ title: 'Added milk' })));
    vi.mocked(sendFcm).mockClear();
    await notify(household.id, { type: 'private', title: 'Secret' }, { to: [ownerMember.id] });
    await prisma.device.update({ where: { id: t.device.id }, data: { revokedAt: new Date() } });
    await notify(household.id, { type: 'list.item_added', title: 'Added bread' });
    expect(sendFcm).not.toHaveBeenCalled();
    expect((await t.get('/notifications')).status).toBe(401);
  });

  it('can test notifications from the tablet without a personal account', async () => {
    const { household } = await makeHousehold();
    const t = await tablet(household.id);
    expect((await t.post('/notifications/test')).body.inApp).toBe(true);
    expect((await t.get('/notifications')).body[0].title).toContain('tablet test');
  });
});
