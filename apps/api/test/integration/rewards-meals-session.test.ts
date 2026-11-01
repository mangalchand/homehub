import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { addMember, app, login, makeHousehold, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const png = () => sharp({ create: { width: 900, height: 600, channels: 3, background: '#33aa66' } }).png().toBuffer();

async function session(email: string) {
  const s = await login(email);
  const csrf = (await s.agent.get('/api/v1/auth/csrf')).body.csrfToken as string;
  return { ...s, upload: async (url: string) => s.agent.post(url).set('x-csrf-token', csrf).attach('file', await png(), 'r.png') };
}

describe('reward pictures', () => {
  it('lets parents upload, serve, replace and remove a reward picture, scoped to the home', async () => {
    const { household, ownerUser } = await makeHousehold();
    const kid = await addMember(household.id, 'CHILD', 'Leo');
    const owner = await session(ownerUser.email);
    const hid = household.id;
    const reward = (await owner.post('/api/v1/households/' + hid + '/rewards', { title: 'Movie night', cost: 30 })).body;
    const base = '/api/v1/households/' + hid + '/rewards/' + reward.id + '/image';
    const up = await owner.upload(base);
    expect(up.status).toBe(200);
    expect(up.body.imageUrl).toMatch(/\/image\?v=[0-9a-f-]{36}$/);
    const file = await owner.get(up.body.imageUrl);
    expect(file.headers['content-type']).toBe('image/webp');
    const meta = await sharp(file.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([640, 480]);
    expect((await owner.get('/api/v1/households/' + hid + '/rewards')).body[0].imageUrl).toBe(up.body.imageUrl);

    const child = await session(kid.user.email);
    expect((await child.upload(base)).status).toBe(403);
    expect((await child.get(up.body.imageUrl)).status).toBe(200);
    const other = await makeHousehold('Other');
    const outsider = await session(other.ownerUser.email);
    expect((await outsider.get(up.body.imageUrl)).status).toBeGreaterThanOrEqual(403);

    const again = await owner.upload(base);
    expect(again.body.imageUrl).not.toBe(up.body.imageUrl);
    expect((await owner.del(base)).body.imageUrl).toBeNull();
    expect((await owner.get(again.body.imageUrl)).status).toBe(404);
  });
});

describe('meal planning', () => {
  it('plans, edits and removes meals per home, with list permissions', async () => {
    const { household, ownerUser } = await makeHousehold();
    const kid = await addMember(household.id, 'CHILD', 'Mia');
    const guest = await addMember(household.id, 'GUEST', 'Gus');
    const owner = await login(ownerUser.email);
    const url = '/api/v1/households/' + household.id + '/meals';
    const created = await owner.post(url, { date: '2026-11-02', slot: 'DINNER', title: '  Tacos ', notes: 'Kids make salsa' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ date: '2026-11-02', slot: 'DINNER', title: 'Tacos' });
    expect((await (await login(kid.user.email)).post(url, { date: '2026-11-03', slot: 'LUNCH', title: 'Pasta' })).status).toBe(201);
    expect((await (await login(guest.user.email)).post(url, { date: '2026-11-03', slot: 'LUNCH', title: 'X' })).status).toBe(403);
    expect((await owner.post(url, { date: '2026-11-03', slot: 'BRUNCH', title: 'X' })).status).toBe(400);

    const week = await owner.get(url + '?start=2026-11-02&end=2026-11-08');
    expect(week.body.map((m: { title: string }) => m.title)).toEqual(['Tacos', 'Pasta']);
    expect((await owner.get(url + '?start=2026-11-01&end=2027-03-01')).status).toBe(400);

    const patched = await owner.patch(url + '/' + created.body.id, { title: 'Fish tacos' });
    expect(patched.body).toMatchObject({ title: 'Fish tacos', slot: 'DINNER', notes: 'Kids make salsa' });
    const other = await makeHousehold('Other');
    const outsider = await login(other.ownerUser.email);
    expect((await outsider.patch('/api/v1/households/' + other.household.id + '/meals/' + created.body.id, { title: 'Hijack' })).status).toBe(404);
    expect((await owner.del(url + '/' + created.body.id)).status).toBe(204);
    expect((await owner.get(url + '?start=2026-11-02&end=2026-11-08')).body).toHaveLength(1);
  });
});

describe('session reliability', () => {
  it('labels CSRF failures so clients can refresh the token, and keeps the CSRF cookie across restarts', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'x@y.z', password: 'whatever-123' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF');
    const cookie = String((await request(app).get('/api/v1/auth/csrf')).headers['set-cookie']);
    expect(cookie).toMatch(/fh_csrf=.*Max-Age=\d+/);
  });

  it('renews an active session before it expires', async () => {
    const { ownerUser } = await makeHousehold();
    const s = await login(ownerUser.email);
    const soon = new Date(Date.now() + 86400000);
    await prisma.session.updateMany({ where: { userId: ownerUser.id }, data: { expiresAt: soon, lastSeenAt: new Date(Date.now() - 3600000) } });
    const me = await s.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(String(me.headers['set-cookie'])).toMatch(/fh_session=/);
    await new Promise((r) => setTimeout(r, 200));
    const row = await prisma.session.findFirstOrThrow({ where: { userId: ownerUser.id } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 86400000);
    expect((await s.get('/api/v1/auth/me')).status).toBe(200);
  });
});
