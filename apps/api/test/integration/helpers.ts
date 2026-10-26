import request from 'supertest';
import type { MemberRole } from '@familyhub/shared';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';
import { hashSecret } from '../../src/auth/passwords.js';
import { createHouseholdWithDefaults } from '../../src/services/households.js';

export const app = createApp();
export const PASSWORD = 'Sup3r-secret-pass';

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(',')} CASCADE`);
}

let n = 0;
export async function makeUser(name: string) {
  n++;
  return prisma.user.create({ data: { email: `${name.toLowerCase()}${n}@test.local`, displayName: name, passwordHash: await hashSecret(PASSWORD), emailVerifiedAt: new Date() } });
}

export async function makeHousehold(name = 'Test Family') {
  const owner = await makeUser('Owner');
  const { household, owner: member } = await createHouseholdWithDefaults({ userId: owner.id, name, timezone: 'America/New_York', ownerFirstName: 'Owner', ownerColor: '#6366f1' });
  return { household, ownerUser: owner, ownerMember: member };
}

export async function addMember(householdId: string, role: MemberRole, name: string) {
  const user = await makeUser(name);
  const member = await prisma.householdMember.create({ data: { householdId, userId: user.id, firstName: name, displayName: name, role, color: '#10b981' } });
  return { user, member };
}

/** A logged-in supertest agent that sends the CSRF header automatically on writes. */
export async function login(email: string) {
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/v1/auth/csrf')).body.csrfToken as string;
  const res = await agent.post('/api/v1/auth/login').set('x-csrf-token', csrf).send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const withCsrf = <T extends { set: (k: string, v: string) => T }>(r: T) => r.set('x-csrf-token', csrf);
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => withCsrf(agent.post(url)).send(body ?? {}),
    patch: (url: string, body?: object) => withCsrf(agent.patch(url)).send(body ?? {}),
    del: (url: string, body?: object) => withCsrf(agent.delete(url)).send(body ?? {}),
  };
}
