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
