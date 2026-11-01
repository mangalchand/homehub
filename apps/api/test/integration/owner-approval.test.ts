import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { prisma } from '../../src/db.js';
import { emailAdapter, type EmailMessage } from '../../src/lib/email.js';
import { app, resetDb } from './helpers.js';

const BOSS = 'boss@example.com';
const outbox = () => (emailAdapter as unknown as { outbox: EmailMessage[] }).outbox;
const lastLink = () => {
  const m = [...outbox()].reverse().find((x) => x.to === BOSS);
  return /\/api\/v1\/approvals\/([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1];
};

beforeEach(async () => {
  await resetDb();
  config.PLATFORM_OWNER_EMAIL = BOSS;
});
afterEach(() => {
  config.PLATFORM_OWNER_EMAIL = '';
});
afterAll(() => prisma.$disconnect());

async function register(email: string) {
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/v1/auth/csrf')).body.csrfToken as string;
  const r = await agent.post('/api/v1/auth/register').set('x-csrf-token', csrf).send({ email, displayName: 'Nia', password: 'Correct-horse-9' });
  expect(r.status).toBe(201);
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const createHome = () => agent.post('/api/v1/households').set('x-csrf-token', csrf).send({ name: 'Nia home', timezone: 'UTC' });
  return { agent, createHome };
}

describe('owner approval', () => {
  it('keeps new accounts and homes pending until the owner approves by email', async () => {
    const { agent, createHome } = await register('nia@example.com');
    expect((await agent.get('/api/v1/auth/me')).body.user.approvalStatus).toBe('PENDING');
    expect((await createHome()).body.error.code).toBe('ACCOUNT_PENDING_APPROVAL');

    const token = lastLink()!;
    expect(token).toBeTruthy();
    expect((await request(app).get('/api/v1/approvals/' + token)).text).toContain('nia@example.com');
    expect((await request(app).post('/api/v1/approvals/' + token + '/approve')).status).toBe(200);
    expect((await request(app).post('/api/v1/approvals/' + token + '/approve')).status).toBe(404);
    expect((await agent.get('/api/v1/auth/me')).body.user.approvalStatus).toBe('APPROVED');
    expect(outbox().some((m) => m.to === 'nia@example.com' && /approved/.test(m.subject))).toBe(true);

    const created = await createHome();
    expect(created.status).toBe(201);
    expect(created.body.approvalStatus).toBe('PENDING');
    const hid = created.body.household.id as string;
    const me = (await agent.get('/api/v1/auth/me')).body;
    expect(me.memberships).toHaveLength(0);
    expect(me.pendingHouseholds[0].householdId).toBe(hid);
    expect((await agent.get('/api/v1/households/' + hid + '/members')).body.error.code).toBe('HOUSEHOLD_PENDING_APPROVAL');

    const homeToken = lastLink()!;
    expect(homeToken).not.toBe(token);
    expect((await request(app).get('/api/v1/approvals/' + homeToken)).text).toContain('Nia home');
    await request(app).post('/api/v1/approvals/' + homeToken + '/approve');
    expect((await agent.get('/api/v1/households/' + hid + '/members')).status).toBe(200);
  });

  it('lets a pending requester resend the approval email, replacing the old link', async () => {
    const { agent } = await register('ravi@example.com');
    const first = lastLink()!;
    const csrf = (await agent.get('/api/v1/auth/csrf')).body.csrfToken as string;
    const r = await agent.post('/api/v1/approval-requests/resend').set('x-csrf-token', csrf);
    expect(r.status).toBe(200);
    expect(r.body.requested).toBe(1);
    const second = lastLink()!;
    expect(second).not.toBe(first);
    expect((await request(app).post('/api/v1/approvals/' + first + '/approve')).status).toBe(404);
    expect((await agent.post('/api/v1/approval-requests/resend').set('x-csrf-token', csrf)).status).toBe(429);
    expect((await request(app).post('/api/v1/approvals/' + second + '/approve')).status).toBe(200);
    expect((await agent.get('/api/v1/auth/me')).body.user.approvalStatus).toBe('APPROVED');
  });

  it('signs out rejected accounts and auto-approves the owner', async () => {
    const { agent } = await register('mallory@example.com');
    await request(app).post('/api/v1/approvals/' + lastLink()! + '/reject');
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'mallory@example.com' } })).approvalStatus).toBe('REJECTED');
    expect((await request(app).post('/api/v1/approvals/not-a-real-token/approve')).status).toBe(404);

    const before = outbox().length;
    const boss = await register(BOSS);
    expect((await boss.agent.get('/api/v1/auth/me')).body.user.approvalStatus).toBe('APPROVED');
    expect((await boss.createHome()).body.approvalStatus).toBe('APPROVED');
    expect(outbox().slice(before).some((m) => m.to === BOSS && /approve/.test(m.subject))).toBe(false);
  });
});
