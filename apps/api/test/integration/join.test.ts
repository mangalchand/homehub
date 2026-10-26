import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { randomToken, sha256 } from '../../src/lib/crypto.js';
import { emailAdapter } from '../../src/lib/email.js';
import { hashSecret } from '../../src/auth/passwords.js';
import { app, login, makeHousehold, PASSWORD, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const outbox = (emailAdapter as unknown as { outbox: { to: string; subject: string; text: string }[] }).outbox;
const lastCode = (to: string, subject: string) => {
  const msg = [...outbox].reverse().find((m) => m.to === to && m.subject.includes(subject));
  return msg?.text.match(/code: (\d{6})/)?.[1] ?? '';
};

async function register(email: string, displayName = 'New Person') {
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/v1/auth/csrf')).body.csrfToken as string;
  const res = await agent.post('/api/v1/auth/register').set('x-csrf-token', csrf).send({ email, password: PASSWORD, displayName });
  expect(res.status).toBe(201);
  return {
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set('x-csrf-token', csrf).send(body ?? {}),
  };
}

async function verified(email: string) {
  const s = await register(email);
  expect((await s.post('/api/v1/auth/verify-email', { code: lastCode(email, 'Confirm your') })).status).toBe(200);
  return s;
}

describe('email verification', () => {
  it('requires the emailed code before an account can be used', async () => {
    const s = await register('fresh@test.local');
    expect((await s.get('/api/v1/auth/me')).body.user.emailVerified).toBe(false);
    const blocked = await s.post('/api/v1/households', { name: 'Mine' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await s.post('/api/v1/auth/verify-email', { code: '000000' === lastCode('fresh@test.local', 'Confirm') ? '111111' : '000000' })).status).toBe(400);
    expect((await s.post('/api/v1/auth/verify-email', { code: lastCode('fresh@test.local', 'Confirm') })).status).toBe(200);
    expect((await s.get('/api/v1/auth/me')).body.user.emailVerified).toBe(true);
    expect((await s.post('/api/v1/households', { name: 'Mine' })).status).toBe(201);
  });
});

describe('joining a household', () => {
  async function invite() {
    const { household, ownerUser } = await makeHousehold();
    const owner = await login(ownerUser.email);
    const base = `/api/v1/households/${household.id}`;
    const inv = await owner.post(`${base}/invitations`, { email: 'joiner@test.local', role: 'ADULT' });
    expect(inv.status).toBe(201);
    const token = (inv.body.acceptUrl as string).split('/invite/')[1]!;
    const joiner = await verified('joiner@test.local');
    const req = await joiner.post('/api/v1/invitations/accept', { token });
    expect(req.status).toBe(201);
    expect(req.body.joinRequest.status).toBe('pending');
    return { household, base, owner, ownerUser, joiner, id: req.body.joinRequest.id as string };
  }

  it('needs the requester code and an admin code', async () => {
    const { base, owner, ownerUser, joiner, id } = await invite();
    expect((await joiner.get(base)).status).toBe(404);
    expect((await joiner.post(`/api/v1/join-requests/${id}/verify`, { code: lastCode('joiner@test.local', 'Your code to join') })).body.requesterVerified).toBe(true);
    expect((await joiner.get(base)).status).toBe(404);
    expect((await owner.get(`${base}/join-requests`)).body).toHaveLength(1);
    expect((await owner.post(`${base}/join-requests/${id}/approve`, {})).status).toBe(400);
    const ok = await owner.post(`${base}/join-requests/${id}/approve`, { code: lastCode(ownerUser.email, 'Approve') });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect((await joiner.get(base)).status).toBe(200);
  });

  it('can be approved on a paired home device without a code', async () => {
    const { household, base, joiner, id } = await invite();
    const device = await prisma.device.create({ data: { householdId: household.id, name: 'Kitchen', pairedAt: new Date() } });
    const token = randomToken(32);
    await prisma.session.create({ data: { tokenHash: sha256(token), deviceId: device.id, householdId: household.id, expiresAt: new Date(Date.now() + 86400000) } });
    const cookie = `fh_session=${token}; fh_csrf=testcsrf`;
    const approve = await request(app).post(`${base}/join-requests/${id}/approve`).set('Cookie', cookie).set('x-csrf-token', 'testcsrf').send({});
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('pending');
    const done = await joiner.post(`/api/v1/join-requests/${id}/verify`, { code: lastCode('joiner@test.local', 'Your code to join') });
    expect(done.body.status).toBe('approved');
    expect((await joiner.get(base)).status).toBe(200);
  });

  it('lets an admin decline', async () => {
    const { base, owner, joiner, id } = await invite();
    expect((await owner.post(`${base}/join-requests/${id}/reject`)).body.status).toBe('rejected');
    expect((await joiner.post(`/api/v1/join-requests/${id}/verify`, { code: '123456' })).status).toBe(404);
  });

  it('lets a PIN-unlocked home display add a member and send an invite', async () => {
    const { household } = await makeHousehold();
    const base = `/api/v1/households/${household.id}`;
    await prisma.household.update({ where: { id: household.id }, data: { pinHash: await hashSecret('4321') } });
    const device = await prisma.device.create({ data: { householdId: household.id, name: 'Tablet', pairedAt: new Date() } });
    const token = randomToken(32);
    await prisma.session.create({ data: { tokenHash: sha256(token), deviceId: device.id, householdId: household.id, expiresAt: new Date(Date.now() + 86400000) } });
    const send = (path: string, body: object) => request(app).post(`${base}${path}`).set('Cookie', `fh_session=${token}; fh_csrf=c`).set('x-csrf-token', 'c').send(body);
    expect((await send('/members', { firstName: 'Nana', role: 'GUEST' })).status).toBe(403);
    expect((await send('/pin/verify', { pin: '4321' })).status).toBe(200);
    const created = await send('/members', { firstName: 'Nana', role: 'GUEST' });
    expect(created.status).toBe(201);
    expect((await send('/members', { firstName: 'Boss', role: 'ADULT_ADMIN' })).status).toBe(403);
    const inv = await send('/invitations', { email: 'nana@test.local', role: 'GUEST', memberId: created.body.id });
    expect(inv.status).toBe(201);
    expect(inv.body.acceptUrl).toContain('/invite/');
  });

  it('lets a home display add a simple task by voice without the PIN, but not chores', async () => {
    const { household } = await makeHousehold();
    const base = `/api/v1/households/${household.id}`;
    const device = await prisma.device.create({ data: { householdId: household.id, name: 'Wall', pairedAt: new Date() } });
    const token = randomToken(32);
    await prisma.session.create({ data: { tokenHash: sha256(token), deviceId: device.id, householdId: household.id, expiresAt: new Date(Date.now() + 86400000) } });
    const send = (body: object) => request(app).post(`${base}/tasks`).set('Cookie', `fh_session=${token}; fh_csrf=c`).set('x-csrf-token', 'c').send(body);
    expect((await send({ kind: 'TASK', title: 'Call the plumber' })).status).toBe(201);
    expect((await send({ kind: 'CHORE', title: 'Free points', points: 100 })).status).toBe(403);
  });
});
