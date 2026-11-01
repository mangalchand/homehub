import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import type { MediaAsset } from '@prisma/client';
import { can } from '@familyhub/shared';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';
import { storage } from '../lib/storage.js';
import { ctx, householdContext, requireCap } from '../auth/context.js';
import { notify } from '../lib/notify.js';

const MAX_FILES = 20;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: MAX_FILES } });

export function photoDTO(a: MediaAsset, householdId: string) {
  const base = `/api/v1/households/${householdId}/photos/${a.id}`;
  return {
    id: a.id, caption: a.caption, width: a.width, height: a.height, takenAt: a.takenAt?.toISOString() ?? null,
    isFavorite: a.isFavorite, uploadedBy: a.uploadedBy, createdAt: a.createdAt.toISOString(),
    url: `${base}/file`, thumbUrl: `${base}/file?size=thumb`,
  };
}

/** Parses EXIF DateTimeOriginal ("YYYY:MM:DD HH:MM:SS") from a raw EXIF buffer without extra deps. */
function exifTakenAt(exif?: Buffer): Date | null {
  if (!exif) return null;
  const m = /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(exif.toString('latin1'));
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const updateSchema = z.object({ caption: z.string().max(280).nullable().optional(), isFavorite: z.boolean().optional() });
const listQuery = z.object({ favorites: z.enum(['true', 'false']).optional(), limit: z.coerce.number().min(1).max(500).default(200) });

const rewardImageKey = (hid: string, rewardId: string, v: string) => `households/${hid}/rewards/${rewardId}/${v}.webp`;
/** Storage key of a reward's current picture, if it has one. */
export function rewardImageObjectKey(householdId: string, reward: { id: string; imageUrl: string | null }) {
  const v = /\/image\?v=([0-9a-f-]{36})$/.exec(reward.imageUrl ?? '')?.[1];
  return v ? rewardImageKey(householdId, reward.id, v) : null;
}

export function photosRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };
  const changed = (hid: string) => realtime.publish(hid, { type: 'photos.changed' });

  route(m, { method: 'get', path: '/photos', summary: 'List family photos (newest first)', tags: ['Photos'], query: listQuery }, async (req, _res, { query }) => {
    const c = ctx(req);
    const rows = await prisma.mediaAsset.findMany({
      where: { householdId: c.householdId, ...(query.favorites === 'true' ? { isFavorite: true } : {}) },
      orderBy: [{ takenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: query.limit,
    });
    return rows.map((r) => photoDTO(r, c.householdId));
  });

  route(
    m,
    { method: 'post', path: '/photos', summary: 'Upload photos (multipart field "files")', tags: ['Photos'], status: 201, middleware: [requireCap('lists.write'), upload.array('files', MAX_FILES)] },
    async (req) => {
      const c = ctx(req);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) throw new AppError(400, 'NO_FILES', 'Choose at least one photo');
      const memberId = c.actor.kind === 'member' ? c.actor.memberId : null;
      const created: MediaAsset[] = [];
      for (const f of files) {
        let img: sharp.Sharp;
        let meta: sharp.Metadata;
        try {
          img = sharp(f.buffer, { failOn: 'error' }).rotate();
          meta = await sharp(f.buffer).metadata();
        } catch {
          throw new AppError(415, 'UNSUPPORTED_IMAGE', `${f.originalname} is not a supported image`);
        }
        if (!meta.format || !['jpeg', 'png', 'webp', 'heif', 'avif', 'gif', 'tiff'].includes(meta.format)) {
          throw new AppError(415, 'UNSUPPORTED_IMAGE', `${f.originalname} is not a supported image`);
        }
        // Re-encode: strips EXIF/GPS metadata and normalizes orientation and size.
        const full = await img.clone().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84, mozjpeg: true }).toBuffer({ resolveWithObject: true });
        const thumb = await img.clone().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
        const key = `households/${c.householdId}/photos/${randomUUID()}`;
        await storage().put(`${key}.jpg`, full.data, 'image/jpeg');
        await storage().put(`${key}_thumb.webp`, thumb, 'image/webp');
        created.push(
          await prisma.mediaAsset.create({
            data: {
              householdId: c.householdId, storageKey: key, mimeType: 'image/jpeg', sizeBytes: full.info.size,
              width: full.info.width, height: full.info.height, takenAt: exifTakenAt(meta.exif), uploadedBy: memberId,
            },
          }),
        );
      }
      await audit(req, { householdId: c.householdId, action: 'photos.uploaded', entityType: 'media', entityId: created[0]!.id, metadata: { count: created.length } });
      changed(c.householdId);
      void notify(c.householdId, { type: 'photos.added', title: created.length === 1 ? 'New family photo' : `${created.length} new family photos`, body: 'Tap to see them', url: '/photos' }, { except: memberId });
      return created.map((r) => photoDTO(r, c.householdId));
    },
  );

  const avatarVersion = (url: string | null) => /\/photo\?v=([0-9a-f-]{36})$/.exec(url ?? '')?.[1] ?? null;
  const avatarKey = (hid: string, memberId: string, v: string) => `households/${hid}/avatars/${memberId}/${v}.webp`;
  const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

  route(
    m,
    { method: 'post', path: '/members/:memberId/photo', summary: 'Upload a profile picture (multipart field "file")', tags: ['Members'], middleware: [requireCap('members.manage'), avatarUpload.single('file')] },
    async (req) => {
      const c = ctx(req);
      const member = await prisma.householdMember.findFirst({ where: { id: req.params.memberId, householdId: c.householdId } });
      if (!member) throw notFound('Member');
      const f = req.file;
      if (!f) throw new AppError(400, 'NO_FILES', 'Choose a photo');
      let data: Buffer;
      try {
        // Re-encode: strips EXIF/GPS metadata, fixes orientation and crops to a square.
        data = await sharp(f.buffer, { failOn: 'error' }).rotate().resize({ width: 512, height: 512, fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toBuffer();
      } catch {
        throw new AppError(415, 'UNSUPPORTED_IMAGE', 'That file is not a supported image');
      }
      const v = randomUUID();
      await storage().put(avatarKey(c.householdId, member.id, v), data, 'image/webp');
      const avatarUrl = `/api/v1/households/${c.householdId}/members/${member.id}/photo?v=${v}`;
      await prisma.householdMember.update({ where: { id: member.id }, data: { avatarUrl } });
      const old = avatarVersion(member.avatarUrl);
      if (old) await storage().remove(avatarKey(c.householdId, member.id, old)).catch(() => undefined);
      await audit(req, { householdId: c.householdId, action: 'member.photo.updated', entityType: 'member', entityId: member.id });
      realtime.publish(c.householdId, { type: 'members.changed' });
      return { avatarUrl };
    },
  );

  route(
    m,
    { method: 'delete', path: '/members/:memberId/photo', summary: 'Remove a profile picture', tags: ['Members'], middleware: [requireCap('members.manage')] },
    async (req) => {
      const c = ctx(req);
      const member = await prisma.householdMember.findFirst({ where: { id: req.params.memberId, householdId: c.householdId } });
      if (!member) throw notFound('Member');
      await prisma.householdMember.update({ where: { id: member.id }, data: { avatarUrl: null } });
      const old = avatarVersion(member.avatarUrl);
      if (old) await storage().remove(avatarKey(c.householdId, member.id, old)).catch(() => undefined);
      await audit(req, { householdId: c.householdId, action: 'member.photo.removed', entityType: 'member', entityId: member.id });
      realtime.publish(c.householdId, { type: 'members.changed' });
      return { avatarUrl: null };
    },
  );

  router.get('/members/:memberId/photo', async (req, res, next) => {
    try {
      const c = ctx(req);
      const member = await prisma.householdMember.findFirst({ where: { id: req.params.memberId, householdId: c.householdId } });
      const v = avatarVersion(member?.avatarUrl ?? null);
      const body = member && v ? await storage().get(avatarKey(c.householdId, member.id, v)) : null;
      if (!body) throw notFound('Photo');
      res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.send(body);
    } catch (e) {
      next(e);
    }
  });

  route(
    m,
    { method: 'post', path: '/rewards/:rewardId/image', summary: 'Upload a reward picture (multipart field "file")', tags: ['Rewards'], middleware: [requireCap('rewards.manage'), avatarUpload.single('file')] },
    async (req) => {
      const c = ctx(req);
      const reward = await prisma.reward.findFirst({ where: { id: req.params.rewardId, householdId: c.householdId } });
      if (!reward) throw notFound('Reward');
      const f = req.file;
      if (!f) throw new AppError(400, 'NO_FILES', 'Choose a picture');
      let data: Buffer;
      try {
        data = await sharp(f.buffer, { failOn: 'error' }).rotate().resize({ width: 640, height: 480, fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toBuffer();
      } catch {
        throw new AppError(415, 'UNSUPPORTED_IMAGE', 'That file is not a supported image');
      }
      const v = randomUUID();
      await storage().put(rewardImageKey(c.householdId, reward.id, v), data, 'image/webp');
      const imageUrl = `/api/v1/households/${c.householdId}/rewards/${reward.id}/image?v=${v}`;
      await prisma.reward.update({ where: { id: reward.id }, data: { imageUrl } });
      const old = rewardImageObjectKey(c.householdId, reward);
      if (old) await storage().remove(old).catch(() => undefined);
      await audit(req, { householdId: c.householdId, action: 'reward.image.updated', entityType: 'reward', entityId: reward.id });
      realtime.publish(c.householdId, { type: 'rewards.changed' });
      return { imageUrl };
    },
  );

  route(
    m,
    { method: 'delete', path: '/rewards/:rewardId/image', summary: 'Remove a reward picture', tags: ['Rewards'], middleware: [requireCap('rewards.manage')] },
    async (req) => {
      const c = ctx(req);
      const reward = await prisma.reward.findFirst({ where: { id: req.params.rewardId, householdId: c.householdId } });
      if (!reward) throw notFound('Reward');
      await prisma.reward.update({ where: { id: reward.id }, data: { imageUrl: null } });
      const old = rewardImageObjectKey(c.householdId, reward);
      if (old) await storage().remove(old).catch(() => undefined);
      realtime.publish(c.householdId, { type: 'rewards.changed' });
      return { imageUrl: null };
    },
  );

  router.get('/rewards/:rewardId/image', async (req, res, next) => {
    try {
      const c = ctx(req);
      const reward = await prisma.reward.findFirst({ where: { id: req.params.rewardId, householdId: c.householdId } });
      const current = reward?.imageUrl?.endsWith('?v=' + String(req.query.v));
      const key = reward && current ? rewardImageObjectKey(c.householdId, reward) : null;
      const body = key ? await storage().get(key) : null;
      if (!body) throw notFound('Picture');
      res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.send(body);
    } catch (e) {
      next(e);
    }
  });

  router.get('/photos/:photoId/file', async (req, res, next) => {
    try {
      const c = ctx(req);
      const a = await prisma.mediaAsset.findFirst({ where: { id: req.params.photoId, householdId: c.householdId } });
      if (!a) throw notFound('Photo');
      const thumb = req.query.size === 'thumb';
      const body = await storage().get(thumb ? `${a.storageKey}_thumb.webp` : `${a.storageKey}.jpg`);
      if (!body) throw notFound('Photo');
      res.set({ 'Content-Type': thumb ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.send(body);
    } catch (e) {
      next(e);
    }
  });

  route(m, { method: 'patch', path: '/photos/:photoId', summary: 'Update caption / favorite', tags: ['Photos'], body: updateSchema, middleware: [requireCap('lists.write')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const a = await prisma.mediaAsset.findFirst({ where: { id: req.params.photoId, householdId: c.householdId } });
    if (!a) throw notFound('Photo');
    const updated = await prisma.mediaAsset.update({ where: { id: a.id }, data: body });
    changed(c.householdId);
    return photoDTO(updated, c.householdId);
  });

  route(m, { method: 'delete', path: '/photos/:photoId', summary: 'Delete a photo', tags: ['Photos'], status: 204 }, async (req, res) => {
    const c = ctx(req);
    const a = await prisma.mediaAsset.findFirst({ where: { id: req.params.photoId, householdId: c.householdId } });
    if (!a) throw notFound('Photo');
    const own = c.actor.kind === 'member' && c.actor.memberId === a.uploadedBy;
    if (!own && !can(c.actor, 'dashboard.manage')) throw forbidden('Only the uploader or an adult admin can delete this photo');
    await prisma.mediaAsset.delete({ where: { id: a.id } });
    await Promise.all([storage().remove(`${a.storageKey}.jpg`), storage().remove(`${a.storageKey}_thumb.webp`)]);
    await audit(req, { householdId: c.householdId, action: 'photos.deleted', entityType: 'media', entityId: a.id });
    changed(c.householdId);
    res.status(204);
    return undefined;
  });

  return router;
}
