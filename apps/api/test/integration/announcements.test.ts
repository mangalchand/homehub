import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { login, makeHousehold, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('announcement schedules', () => {
  it('preserves partial edits and rejects invalid daily schedule transitions', async () => {
    const { household, ownerUser } = await makeHousehold();
    const owner = await login(ownerUser.email);
    const base = `/api/v1/households/${household.id}/announcements`;
    const created = await owner.post(base, {
      title: 'Medicine time',
      repeatDaily: true,
      dailyTime: '08:30',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ repeatDaily: true, dailyTime: '08:30' });

    const partial = await owner.patch(`${base}/${created.body.id}`, { title: 'Take medicine' });
    expect(partial.status).toBe(200);
    expect(partial.body).toMatchObject({ title: 'Take medicine', repeatDaily: true, dailyTime: '08:30' });

    const cleared = await owner.patch(`${base}/${created.body.id}`, { repeatDaily: false });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ repeatDaily: false, dailyTime: null });

    const missingTime = await owner.patch(`${base}/${created.body.id}`, { repeatDaily: true });
    expect(missingTime.status).toBe(400);
    const reenabled = await owner.patch(`${base}/${created.body.id}`, {
      repeatDaily: true,
      dailyTime: '07:45',
    });
    expect(reenabled.status).toBe(200);
    const clearedTime = await owner.patch(`${base}/${created.body.id}`, { dailyTime: null });
    expect(clearedTime.status).toBe(400);
    expect(await prisma.announcement.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject({
      repeatDaily: true,
      dailyTime: '07:45',
    });
  });
});
