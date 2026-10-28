import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_SIZE_BYTES } from '@familyhub/shared';
import { prisma } from '../../src/db.js';
import { authenticate, csrfProtection } from '../../src/auth/session.js';
import { sha256 } from '../../src/lib/crypto.js';
import { errorHandler } from '../../src/lib/errors.js';
import { storage } from '../../src/lib/storage.js';
import { realtime } from '../../src/lib/realtime.js';
import { retryAttachmentObjectCleanup, thumbnailKey } from '../../src/lib/attachments.js';
import { notesRouter } from '../../src/routes/notes.js';
import { attachmentsRouter } from '../../src/routes/attachments.js';
import { tasksRouter } from '../../src/routes/tasks.js';
import { addMember, makeHousehold, resetDb } from './helpers.js';

vi.mock('../../src/lib/notify.js', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));
const app = express();
app.use(express.json(), cookieParser(), authenticate, csrfProtection([]));
const scoped = '/api/v1/households/:householdId';
app.use(scoped, notesRouter(), attachmentsRouter(), tasksRouter());
app.use(errorHandler);

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  const rows = await prisma.attachment.findMany();
  for (const row of rows) {
    await storage().remove(row.storageKey);
    await storage().remove(thumbnailKey(row.storageKey));
  }
});
afterAll(() => prisma.$disconnect());

async function client(
  subject: { userId: string } | { deviceId: string; householdId: string },
  elevated = false,
) {
  const token = randomUUID();
  const session = await prisma.session.create({
    data: {
      ...subject,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 3600_000),
      pinElevatedUntil: elevated ? new Date(Date.now() + 60_000) : null,
    },
  });
  const cookie = `fh_session=${token}; fh_csrf=notes-test`;
  return {
    session,
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    post: (url: string, body: object = {}) =>
      request(app).post(url).set('Cookie', cookie).set('x-csrf-token', 'notes-test').send(body),
    patch: (url: string, body: object) =>
      request(app).patch(url).set('Cookie', cookie).set('x-csrf-token', 'notes-test').send(body),
    del: (url: string) => request(app).delete(url).set('Cookie', cookie).set('x-csrf-token', 'notes-test'),
    upload: (url: string, buffer: Buffer, mimeType = 'image/jpeg') =>
      request(app)
        .post(url)
        .set('Cookie', cookie)
        .set('x-csrf-token', 'notes-test')
        .attach('file', buffer, { filename: '../../source.jpg', contentType: mimeType }),
    rawUpload: (url: string) =>
      request(app).post(url).set('Cookie', cookie).set('x-csrf-token', 'notes-test'),
  };
}
const base = (id: string) => `/api/v1/households/${id}`;
const image = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } })
    .jpeg()
    .toBuffer();

async function fixture() {
  const h = await makeHousehold();
  const owner = await client({ userId: h.ownerUser.id });
  const url = base(h.household.id);
  const note = await owner.post(`${url}/notes`, { title: 'House instructions', body: 'Feed the cat.' });
  expect(note.status).toBe(201);
  const task = await prisma.task.create({
    data: { householdId: h.household.id, title: 'Fix shelf', createdById: h.ownerUser.id },
  });
  return { ...h, owner, url, note: note.body, task };
}

describe('household notes and image attachments', () => {
  it('requires active authorization and CSRF on writes, and denies revoked displays or expired guests', async () => {
    const h = await fixture();
    const url = `${h.url}/notes/${h.note.id}/attachments`;
    expect((await request(app).get(`${h.url}/notes`)).status).toBe(401);
    expect(
      (
        await request(app)
          .post(url)
          .set('Cookie', 'fh_csrf=notes-test')
          .attach('file', await image(), 'image.jpg')
      ).status,
    ).toBe(403);
    const token = randomUUID();
    await prisma.session.create({
      data: { userId: h.ownerUser.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) },
    });
    expect(
      (
        await request(app)
          .post(url)
          .set('Cookie', `fh_session=${token}; fh_csrf=notes-test`)
          .attach('file', await image(), 'image.jpg')
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`${h.url}/notes`)
          .set('Cookie', `fh_session=${token}; fh_csrf=notes-test`)
          .send({ title: 'No CSRF' })
      ).status,
    ).toBe(403);
    const uploaded = await h.owner.upload(url, await image());
    const device = await prisma.device.create({ data: { householdId: h.household.id, name: 'Kitchen' } });
    const d = await client({ deviceId: device.id, householdId: h.household.id });
    await prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    expect((await d.get(`${h.url}/attachments/${uploaded.body.id}/file`)).status).toBe(401);
    const guest = await addMember(h.household.id, 'GUEST', 'Guest');
    const g = await client({ userId: guest.user.id });
    await prisma.householdMember.update({
      where: { id: guest.member.id },
      data: { accessExpiresAt: new Date(0) },
    });
    expect((await g.get(`${h.url}/attachments/${uploaded.body.id}/file?size=thumb`)).status).toBe(403);
    expect((await g.get(`${h.url}/notes`)).status).toBe(403);
  });

  it('keeps text, filenames and storage keys out of invalidations/audit and sanitizes storage read failures', async () => {
    const h = await fixture();
    const publish = vi.spyOn(realtime, 'publish');
    const created = await h.owner.post(`${h.url}/notes`, {
      title: 'Private note title',
      body: 'Private note body',
    });
    const uploaded = await h.owner.upload(`${h.url}/notes/${created.body.id}/attachments`, await image());
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: uploaded.body.id } });
    const invalidations = JSON.stringify(publish.mock.calls);
    for (const hidden of ['Private note title', 'Private note body', row.storageKey, 'source.jpg'])
      expect(invalidations).not.toContain(hidden);
    const audit = JSON.stringify(await prisma.auditLog.findMany({ where: { householdId: h.household.id } }));
    for (const hidden of ['Private note title', 'Private note body', row.storageKey, 'source.jpg'])
      expect(audit).not.toContain(hidden);
    expect(audit).toContain('attachment.created');
    expect((await h.owner.get(`${h.url}/notes`)).headers['cache-control']).toBe('private, no-store');
    expect(
      (await h.owner.get(`${h.url}/notes/${created.body.id}/attachments`)).headers['cache-control'],
    ).toBe('private, no-store');
    vi.spyOn(storage(), 'get').mockRejectedValue(new Error('sensitive-storage-vendor-key'));
    const failed = await h.owner.get(`${h.url}/attachments/${row.id}/file`);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('sensitive-storage');
  });

  it('pages older notes with a stable updatedAt and id cursor', async () => {
    const h = await fixture();
    await prisma.note.update({ where: { id: h.note.id }, data: { updatedAt: new Date(Date.now() - 3_600_000) } });
    const created = [];
    for (let index = 0; index < 3; index++) {
      created.push(
        await prisma.note.create({
          data: {
            householdId: h.household.id,
            authorMemberId: h.ownerMember.id,
            title: `Paged ${index}`,
            updatedAt: new Date(Date.now() - index * 60_000),
          },
        }),
      );
    }
    const first = await h.owner.get(`${h.url}/notes?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.map((note: { id: string }) => note.id)).toEqual([created[0]!.id, created[1]!.id]);
    const second = await h.owner.get(`${h.url}/notes?limit=2&before=${first.body[1].id}`);
    expect(second.status).toBe(200);
    expect(second.body.map((note: { id: string }) => note.id)).toEqual([created[2]!.id, h.note.id]);
    expect((await h.owner.get(`${h.url}/notes?before=${crypto.randomUUID()}`)).status).toBe(400);
  });

  it('persists notes with server-derived authors, preserves omitted fields, and enforces author/admin rights', async () => {
    const h = await fixture();
    const kid = await addMember(h.household.id, 'CHILD', 'Kid');
    const sibling = await addMember(h.household.id, 'CHILD', 'Sibling');
    const adult = await addMember(h.household.id, 'ADULT', 'Adult');
    const admin = await addMember(h.household.id, 'ADULT_ADMIN', 'Admin');
    const guest = await addMember(h.household.id, 'GUEST', 'Guest');
    const k = await client({ userId: kid.user.id });
    const s = await client({ userId: sibling.user.id });
    const a = await client({ userId: adult.user.id });
    const ad = await client({ userId: admin.user.id });
    const g = await client({ userId: guest.user.id });
    const created = await k.post(`${h.url}/notes`, { title: '  My note  ', body: 'Keep this body' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'My note',
      authorMemberId: kid.member.id,
      authorDeviceId: null,
      attachments: [],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const path = `${h.url}/notes/${created.body.id}`;
    expect((await s.patch(path, { title: 'No' })).status).toBe(403);
    expect((await a.del(path)).status).toBe(403);
    const edited = await k.patch(path, { title: 'Updated' });
    expect(edited.status).toBe(200);
    expect(edited.body.body).toBe('Keep this body');
    expect((await g.get(path)).body.title).toBe('Updated');
    expect((await g.post(`${h.url}/notes`, { title: 'No' })).status).toBe(403);
    expect((await k.post(`${h.url}/notes`, { title: 'Bad', authorMemberId: h.ownerMember.id })).status).toBe(
      400,
    );
    expect((await k.patch(path, { body: 'x'.repeat(10001) })).status).toBe(400);
    expect((await k.patch(path, {})).status).toBe(400);
    expect((await k.patch(path, { title: ' ' })).status).toBe(400);
    expect((await ad.patch(path, { body: 'Admin edit' })).status).toBe(200);
    expect((await ad.del(path)).status).toBe(204);
    expect((await k.get(path)).status).toBe(404);
  });

  it('limits paired displays to their home and own notes unless PIN elevated; expired elevation cannot edit others', async () => {
    const h = await fixture();
    const other = await makeHousehold();
    const device = await prisma.device.create({ data: { householdId: h.household.id, name: 'Kitchen' } });
    const device2 = await prisma.device.create({ data: { householdId: h.household.id, name: 'Hall' } });
    const d = await client({ deviceId: device.id, householdId: h.household.id });
    const d2 = await client({ deviceId: device2.id, householdId: h.household.id });
    const note = await d.post(`${h.url}/notes`, { title: 'Display note' });
    expect(note.body).toMatchObject({ authorMemberId: null, authorDeviceId: device.id });
    expect((await d.patch(`${h.url}/notes/${note.body.id}`, { body: 'Own edit' })).status).toBe(200);
    expect((await d2.del(`${h.url}/notes/${note.body.id}`)).status).toBe(403);
    expect((await d.patch(`${h.url}/notes/${h.note.id}`, { title: 'Not own' })).status).toBe(403);
    const elevated = await client({ deviceId: device.id, householdId: h.household.id }, true);
    expect((await elevated.patch(`${h.url}/notes/${h.note.id}`, { title: 'PIN edit' })).status).toBe(200);
    await prisma.session.update({
      where: { id: elevated.session.id },
      data: { pinElevatedUntil: new Date(0) },
    });
    expect((await elevated.del(`${h.url}/notes/${h.note.id}`)).status).toBe(403);
    expect((await d.get(`${base(other.household.id)}/notes`)).status).toBe(404);
    expect((await d.post(`${base(other.household.id)}/notes`, { title: 'No switching' })).status).toBe(404);
  });

  it('persists task and note images, strips EXIF/GPS and rotates pixels, protecting processed originals and thumbnails', async () => {
    const h = await fixture();
    const source = await sharp(await image())
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Artist: 'Private photographer' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '51/1 30/1 0/1',
          GPSLongitudeRef: 'W',
          GPSLongitude: '0/1 7/1 0/1',
        },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    for (const parent of [`notes/${h.note.id}`, `tasks/${h.task.id}`]) {
      const uploaded = await h.owner.upload(`${h.url}/${parent}/attachments`, source);
      expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
      expect(uploaded.body).toMatchObject({
        mimeType: 'image/webp',
        width: 30,
        height: 40,
        uploaderMemberId: h.ownerMember.id,
        uploaderDeviceId: null,
      });
      expect(uploaded.body).not.toHaveProperty('storageKey');
      expect(uploaded.body).not.toHaveProperty('url');
      const stored = await prisma.attachment.findUniqueOrThrow({ where: { id: uploaded.body.id } });
      expect(stored.sizeBytes).toBeGreaterThan(0);
      expect(stored.householdId).toBe(h.household.id);
      const listed = await h.owner.get(`${h.url}/${parent}/attachments`);
      expect(listed.body.items.map((r: { id: string }) => r.id)).toContain(stored.id);
      expect(listed.body.canUpload).toBe(true);
      expect(listed.body.canDeleteIds).toContain(stored.id);
      for (const suffix of ['', '?size=thumb']) {
        const download = await h.owner.get(`${h.url}/attachments/${stored.id}/file${suffix}`);
        expect(download.status).toBe(200);
        expect(download.headers['cache-control']).toBe('private, no-store');
        expect(download.headers['content-type']).toContain('image/webp');
        const metadata = await sharp(download.body as Buffer).metadata();
        expect(metadata.exif).toBeUndefined();
        expect(metadata.icc).toBeUndefined();
        expect(metadata.xmp).toBeUndefined();
        expect(metadata.orientation).toBeUndefined();
      }
    }
    const note = (await h.owner.get(`${h.url}/notes/${h.note.id}`)).body;
    expect(note.attachments).toHaveLength(1);
    expect(JSON.stringify(note)).not.toContain('attachments/');
  });

  it('rejects malformed, empty, MIME-spoofed, SVG, oversized and excessive-pixel images without metadata writes', async () => {
    const h = await fixture();
    const url = `${h.url}/notes/${h.note.id}/attachments`;
    const jpeg = await image();
    expect((await h.owner.upload(url, Buffer.from('not an image'))).status).toBe(422);
    expect((await h.owner.upload(url, jpeg, 'image/png')).status).toBe(422);
    expect(
      (
        await h.owner.upload(
          url,
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
          'image/svg+xml',
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await h.owner.upload(
          url,
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
        )
      ).status,
    ).toBe(422);
    expect((await h.owner.upload(url, Buffer.alloc(0))).status).toBe(413);
    expect((await h.owner.upload(url, Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1))).status).toBe(413);
    const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    expect((await h.owner.upload(url, huge, 'image/png')).status).toBe(422);
    expect(
      (
        await h.owner
          .rawUpload(url)
          .field('uploaderMemberId', h.ownerMember.id)
          .attach('file', jpeg, { filename: 'image.jpg', contentType: 'image/jpeg' })
      ).status,
    ).toBe(400);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it('accepts PNG and WebP inputs only after decoding/re-encoding and refuses animated images', async () => {
    const h = await fixture();
    const url = `${h.url}/notes/${h.note.id}/attachments`;
    for (const format of ['png', 'webp'] as const) {
      const input = await sharp(await image())
        .toFormat(format)
        .toBuffer();
      expect((await h.owner.upload(url, input, `image/${format}`)).status).toBe(201);
    }
    // Two-frame 2x2 WebP fixture (red then blue).
    const animated = Buffer.from(
      'UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAEAAAEAAGQAAAJWUDggMgAAADABAJ0BKgIAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAABAAABAABkAAAAVlA4IC4AAAA0AQCdASoCAAIAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA',
      'base64',
    );
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
    expect((await h.owner.upload(url, animated, 'image/webp')).status).toBe(422);
  });

  it('enforces same-home note author, task management and display simple-task/PIN limits for uploads and deletion', async () => {
    const h = await fixture();
    const kid = await addMember(h.household.id, 'CHILD', 'Kid');
    const k = await client({ userId: kid.user.id });
    const jpeg = await image();
    const ownNote = await k.post(`${h.url}/notes`, { title: 'Own' });
    expect((await k.upload(`${h.url}/notes/${ownNote.body.id}/attachments`, jpeg)).status).toBe(201);
    expect((await k.upload(`${h.url}/notes/${h.note.id}/attachments`, jpeg)).status).toBe(403);
    expect((await k.upload(`${h.url}/tasks/${h.task.id}/attachments`, jpeg)).status).toBe(403);
    const device = await prisma.device.create({ data: { householdId: h.household.id, name: 'Display' } });
    const otherDevice = await prisma.device.create({ data: { householdId: h.household.id, name: 'Other display' } });
    const d = await client({ deviceId: device.id, householdId: h.household.id });
    const d2 = await client({ deviceId: otherDevice.id, householdId: h.household.id });
    const simple = await d.post(`${h.url}/tasks`, { title: 'Display task', kind: 'TASK' });
    expect(simple.status).toBe(201);
    expect((await d.upload(`${h.url}/tasks/${simple.body.id}/attachments`, jpeg)).status).toBe(403);
    expect((await d2.upload(`${h.url}/tasks/${simple.body.id}/attachments`, jpeg)).status).toBe(403);
    const elevatedSimple = await client({ deviceId: device.id, householdId: h.household.id }, true);
    const uploaded = await elevatedSimple.upload(`${h.url}/tasks/${simple.body.id}/attachments`, jpeg);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.uploaderDeviceId).toBe(device.id);
    expect((await d.del(`${h.url}/attachments/${uploaded.body.id}`)).status).toBe(403);
    expect((await elevatedSimple.del(`${h.url}/attachments/${uploaded.body.id}`)).status).toBe(204);
    expect((await d.upload(`${h.url}/tasks/${h.task.id}/attachments`, jpeg)).status).toBe(403);
    const chore = await prisma.task.create({
      data: {
        householdId: h.household.id,
        title: 'Chore',
        kind: 'CHORE',
        points: 10,
        requiresApproval: true,
      },
    });
    expect((await d.upload(`${h.url}/tasks/${chore.id}/attachments`, jpeg)).status).toBe(403);
    const elevated = await client({ deviceId: device.id, householdId: h.household.id }, true);
    const added = await elevated.upload(`${h.url}/tasks/${chore.id}/attachments`, jpeg);
    expect(added.status).toBe(201);
    expect((await d.del(`${h.url}/attachments/${added.body.id}`)).status).toBe(403);
    expect((await k.del(`${h.url}/attachments/${added.body.id}`)).status).toBe(403);
    expect((await k.get(`${h.url}/attachments/${added.body.id}/file`)).status).toBe(200);
  });

  it('rejects cross-home parent, file and thumbnail access even for a user belonging to both homes', async () => {
    const h = await fixture();
    const other = await makeHousehold();
    await prisma.householdMember.create({
      data: {
        householdId: other.household.id,
        userId: h.ownerUser.id,
        firstName: 'Owner',
        displayName: 'Owner',
        role: 'OWNER',
      },
    });
    const alien = await prisma.note.create({
      data: { householdId: other.household.id, authorMemberId: other.ownerMember.id, title: 'Secret' },
    });
    const alienTask = await prisma.task.create({
      data: { householdId: other.household.id, title: 'Secret task' },
    });
    const jpeg = await image();
    const upload = await h.owner.upload(`${base(other.household.id)}/notes/${alien.id}/attachments`, jpeg);
    expect(upload.status).toBe(201);
    for (const parent of [`notes/${alien.id}`, `tasks/${alienTask.id}`]) {
      expect((await h.owner.upload(`${h.url}/${parent}/attachments`, jpeg)).status).toBe(404);
      expect((await h.owner.get(`${h.url}/${parent}/attachments`)).status).toBe(404);
    }
    expect((await h.owner.get(`${h.url}/notes/${alien.id}`)).status).toBe(404);
    expect((await h.owner.patch(`${h.url}/notes/${alien.id}`, { title: 'No' })).status).toBe(404);
    expect((await h.owner.del(`${h.url}/notes/${alien.id}`)).status).toBe(404);
    for (const suffix of ['', '?size=thumb'])
      expect((await h.owner.get(`${h.url}/attachments/${upload.body.id}/file${suffix}`)).status).toBe(404);
    expect((await h.owner.del(`${h.url}/attachments/${upload.body.id}`)).status).toBe(404);
    expect(
      (await request(app).get(`${base(other.household.id)}/attachments/${upload.body.id}/file`)).status,
    ).toBe(401);
  });

  it('serializes concurrent uploads to a maximum of five per task and note', async () => {
    const h = await fixture();
    const jpeg = await image();
    for (const parent of [`notes/${h.note.id}`, `tasks/${h.task.id}`]) {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => h.owner.upload(`${h.url}/${parent}/attachments`, jpeg)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 201, 201, 409, 409, 409]);
      expect((await h.owner.get(`${h.url}/${parent}/attachments`)).body.items).toHaveLength(5);
    }
  });

  it('cleans image pairs on removal, note deletion and task soft-deletion and refuses access to deleted parents', async () => {
    const h = await fixture();
    const jpeg = await image();
    for (const [kind, id] of [
      ['notes', h.note.id],
      ['tasks', h.task.id],
    ]) {
      const first = await h.owner.upload(`${h.url}/${kind}/${id}/attachments`, jpeg);
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: first.body.id } });
      expect((await h.owner.del(`${h.url}/attachments/${row.id}`)).status).toBe(204);
      expect(await storage().get(row.storageKey)).toBeNull();
      expect(await storage().get(thumbnailKey(row.storageKey))).toBeNull();
      const second = await h.owner.upload(`${h.url}/${kind}/${id}/attachments`, jpeg);
      const row2 = await prisma.attachment.findUniqueOrThrow({ where: { id: second.body.id } });
      expect((await h.owner.del(`${h.url}/${kind}/${id}`)).status).toBe(204);
      expect(await prisma.attachment.findUnique({ where: { id: row2.id } })).toBeNull();
      expect(await storage().get(row2.storageKey)).toBeNull();
      expect(await storage().get(thumbnailKey(row2.storageKey))).toBeNull();
      expect((await h.owner.get(`${h.url}/attachments/${row2.id}/file`)).status).toBe(404);
      expect((await h.owner.upload(`${h.url}/${kind}/${id}/attachments`, jpeg)).status).toBe(404);
    }
  });

  it('compensates partial storage writes and failed metadata commits without exposing storage details', async () => {
    const h = await fixture();
    const jpeg = await image();
    const store = storage();
    const realPut = store.put.bind(store);
    const writes: string[] = [];
    const remove = vi.spyOn(store, 'remove');
    const put = vi.spyOn(store, 'put').mockImplementation(async (key, data, mime) => {
      writes.push(key);
      if (key.endsWith('.thumb.webp')) throw new Error('sensitive-vendor-details');
      return realPut(key, data, mime);
    });
    const failed = await h.owner.upload(`${h.url}/notes/${h.note.id}/attachments`, jpeg);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('sensitive-vendor-details');
    expect(await prisma.attachment.count()).toBe(0);
    expect(remove).toHaveBeenCalledWith(writes[0]);
    expect(await store.get(writes[0]!)).toBeNull();
    put.mockRestore();
    vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (fn: unknown) => {
      return prisma.$transaction(async (db) => {
        await (fn as (db: unknown) => Promise<unknown>)(db);
        throw new Error('Commit failure');
      });
    });
    const put2 = vi.spyOn(store, 'put');
    expect((await h.owner.upload(`${h.url}/notes/${h.note.id}/attachments`, jpeg)).status).toBe(503);
    expect(await prisma.attachment.count()).toBe(0);
    for (const [key] of put2.mock.calls) expect(await store.get(key)).toBeNull();
  });

  it('retries transient cleanup failures while already-removed metadata cannot be used to download files', async () => {
    const h = await fixture();
    const uploaded = await h.owner.upload(`${h.url}/notes/${h.note.id}/attachments`, await image());
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: uploaded.body.id } });
    const store = storage();
    const remove = vi.spyOn(store, 'remove').mockRejectedValue(new Error('outage'));
    expect((await h.owner.del(`${h.url}/attachments/${row.id}`)).status).toBe(204);
    expect(remove).toHaveBeenCalledTimes(6);
    expect(await prisma.attachmentObjectCleanup.count()).toBe(1);
    expect(await store.get(row.storageKey)).not.toBeNull();
    remove.mockRestore();
    expect(await retryAttachmentObjectCleanup(new Date(Date.now() + 60_000))).toBe(0);
    expect(await prisma.attachmentObjectCleanup.count()).toBe(0);
    expect(await store.get(row.storageKey)).toBeNull();
    expect(await store.get(thumbnailKey(row.storageKey))).toBeNull();
    expect((await h.owner.get(`${h.url}/attachments/${row.id}/file`)).status).toBe(404);
  });

  it('does not create unauthorized uploads when the parent is deleted concurrently', async () => {
    const h = await fixture();
    const [upload, deletion] = await Promise.all([
      h.owner.upload(`${h.url}/notes/${h.note.id}/attachments`, await image()),
      h.owner.del(`${h.url}/notes/${h.note.id}`),
    ]);
    expect([201, 404]).toContain(upload.status);
    expect(deletion.status).toBe(204);
    expect(await prisma.attachment.count()).toBe(0);
    expect(await prisma.note.findUnique({ where: { id: h.note.id } })).toBeNull();
  });
});
