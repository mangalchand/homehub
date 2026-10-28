import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { thumbnailKey } from '../../src/lib/attachments.js';
import { storage } from '../../src/lib/storage.js';
import { login, makeHousehold, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());
const path = (id: string, suffix: string) => `/api/v1/households/${id}${suffix}`;

describe('registered family features', () => {
  it('serves the new routes together without blocking existing household routes or leaking another home', async () => {
    const a = await makeHousehold('One');
    const b = await makeHousehold('Two');
    const actor = await login(a.ownerUser.email);
    for (const suffix of ['', '/tasks', '/notes', '/safety', '/summaries/settings', '/summaries/preview', '/family-call']) {
      expect((await actor.get(path(a.household.id, suffix))).status, suffix).toBe(200);
      expect((await actor.get(path(b.household.id, suffix))).status, suffix).toBe(404);
    }
    expect((await actor.post(path(a.household.id, '/notes'), { title: 'Family note', body: 'Remember milk' })).status).toBe(201);
    expect((await actor.patch(path(a.household.id, '/summaries/settings'), { dailySummaryTime: '20:30' })).status).toBe(200);
    expect((await actor.patch(path(a.household.id, '/family-call'), { whatsappCallUrl: 'https://call.whatsapp.com/voice/family-test' })).status).toBe(200);
    const start = await actor.post(path(a.household.id, '/safety'), {});
    expect(start.status).toBe(201);
    expect((await actor.post(path(a.household.id, `/safety/${start.body.id}/stop`), {})).status).toBe(200);
  });

  it('removes original and thumbnail image objects when the household is deleted', async () => {
    const a = await makeHousehold();
    const actor = await login(a.ownerUser.email);
    const note = await actor.post(path(a.household.id, '/notes'), { title: 'With photo' });
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
    const csrf = (await actor.get('/api/v1/auth/csrf')).body.csrfToken as string;
    const upload = await actor.agent.post(path(a.household.id, `/notes/${note.body.id}/attachments`)).set('x-csrf-token', csrf).attach('file', image, { filename: 'photo.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    const row = await prisma.attachment.findFirstOrThrow({ where: { householdId: a.household.id } });
    expect(await storage().get(row.storageKey)).not.toBeNull();
    const deleted = await actor.del(path(a.household.id, ''), { confirmName: a.household.name });
    expect(deleted.status).toBe(204);
    expect(await prisma.attachment.count({ where: { householdId: a.household.id } })).toBe(0);
    expect(await storage().get(row.storageKey)).toBeNull();
    expect(await storage().get(thumbnailKey(row.storageKey))).toBeNull();
  });
});
