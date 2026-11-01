import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { addMember, login, makeHousehold, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const png = () => sharp({ create: { width: 900, height: 600, channels: 3, background: '#3366ff' } }).png().toBuffer();

async function session(email: string) {
  const s = await login(email);
  const csrf = (await s.agent.get('/api/v1/auth/csrf')).body.csrfToken as string;
  return { ...s, upload: async (url: string) => s.agent.post(url).set('x-csrf-token', csrf).attach('file', await png(), 'me.png') };
}

describe('member profile pictures', () => {
  it('lets an admin upload, serve, replace and remove a square photo, scoped to the home', async () => {
    const { household, ownerUser } = await makeHousehold();
    const kid = await addMember(household.id, 'CHILD', 'Leo');
    const owner = await session(ownerUser.email);
    const base = `/api/v1/households/${household.id}/members/${kid.member.id}/photo`;

    const up = await owner.upload(base);
    expect(up.status).toBe(200);
    expect(up.body.avatarUrl).toMatch(new RegExp(`^${base.replace(/[/?]/g, '\\$&')}\\?v=[0-9a-f-]{36}$`));
    const file = await owner.get(up.body.avatarUrl);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    const meta = await sharp(file.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([512, 512]);
    const members = await owner.get(`/api/v1/households/${household.id}/members`);
    expect(members.body.find((m: { id: string }) => m.id === kid.member.id).avatarUrl).toBe(up.body.avatarUrl);

    const child = await session(kid.user.email);
    expect((await child.upload(base)).status).toBe(403);

    const other = await makeHousehold('Other');
    const outsider = await session(other.ownerUser.email);
    expect((await outsider.get(up.body.avatarUrl)).status).toBeGreaterThanOrEqual(403);

    const again = await owner.upload(base);
    expect(again.body.avatarUrl).not.toBe(up.body.avatarUrl);
    expect((await owner.get(up.body.avatarUrl)).status).toBe(200);
    expect((await owner.del(base)).body.avatarUrl).toBeNull();
    expect((await owner.get(base)).status).toBe(404);
  });

  it('rejects files that are not images', async () => {
    const { household, ownerUser } = await makeHousehold();
    const s = await login(ownerUser.email);
    const csrf = (await s.agent.get('/api/v1/auth/csrf')).body.csrfToken as string;
    const res = await s.agent.post(`/api/v1/households/${household.id}/members/${(await prisma.householdMember.findFirstOrThrow({ where: { householdId: household.id } })).id}/photo`)
      .set('x-csrf-token', csrf).attach('file', Buffer.from('not an image'), 'x.png');
    expect(res.status).toBe(415);
  });
});

