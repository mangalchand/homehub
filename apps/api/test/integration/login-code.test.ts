import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { emailAdapter } from '../../src/lib/email.js';
import { app, makeUser, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const outbox = (emailAdapter as unknown as { outbox: { to: string; text: string }[] }).outbox;

async function client() {
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/v1/auth/csrf')).body.csrfToken as string;
  return { get: (url: string) => agent.get(url), post: (url: string, body: object) => agent.post(url).set('x-csrf-token', csrf).send(body) };
}

describe('email-code sign in', () => {
  it('sends a six digit code, signs in without a password, and prevents replay', async () => {
    const user = await makeUser('Person');
    const c = await client();
    expect((await c.post('/api/v1/auth/login-code/request', { email: user.email })).status).toBe(200);
    const code = outbox.at(-1)!.text.match(/code: (\d{6})/)![1]!;
    const row = await prisma.emailCode.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.codeHash).not.toContain(code);
    const r = await c.post('/api/v1/auth/login-code/verify', { email: user.email, code });
    expect(r.status).toBe(200);
    expect((await c.get('/api/v1/auth/me')).body.user.id).toBe(user.id);
    expect((await c.post('/api/v1/auth/login-code/verify', { email: user.email, code })).status).toBe(400);
  });

  it('expires codes, limits attempts and rejects a code for another email', async () => {
    const user = await makeUser('Person');
    const other = await makeUser('Other');
    const c = await client();
    await c.post('/api/v1/auth/login-code/request', { email: user.email });
    const code = outbox.at(-1)!.text.match(/code: (\d{6})/)![1]!;
    expect((await c.post('/api/v1/auth/login-code/request', { email: user.email })).status).toBe(429);
    expect((await c.post('/api/v1/auth/login-code/verify', { email: other.email, code })).status).toBe(400);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await c.post('/api/v1/auth/login-code/verify', { email: user.email, code: wrong })).status).toBe(400);
    expect((await c.post('/api/v1/auth/login-code/verify', { email: user.email, code })).body.error.code).toBe('CODE_EXPIRED');
    await prisma.emailCode.updateMany({ where: { userId: user.id }, data: { attempts: 0, expiresAt: new Date(Date.now() - 1) } });
    expect((await c.post('/api/v1/auth/login-code/verify', { email: user.email, code })).body.error.code).toBe('CODE_EXPIRED');
  });

  it('allows only one concurrent verification of the same code', async () => {
    const user = await makeUser('Person');
    const c = await client();
    await c.post('/api/v1/auth/login-code/request', { email: user.email });
    const code = outbox.at(-1)!.text.match(/code: (\d{6})/)![1]!;
    const responses = await Promise.all([c.post('/api/v1/auth/login-code/verify', { email: user.email, code }), c.post('/api/v1/auth/login-code/verify', { email: user.email, code })]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('does not create an account when a new email asks to sign in', async () => {
    const c = await client();
    expect((await c.post('/api/v1/auth/login-code/request', { email: 'absent@test.local' })).body).toEqual({ ok: true });
    expect(await prisma.user.count()).toBe(0);
    expect((await c.post('/api/v1/auth/login-code/verify', { email: 'absent@test.local', code: '123456' })).status).toBe(400);
  });
});
