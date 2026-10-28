import { randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { MAX_ATTACHMENT_SIZE_BYTES } from '@familyhub/shared';
import { ctx, householdContext } from '../auth/context.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import {
  attachmentDTO,
  attachmentParent,
  ATTACHMENTS_CHANGED_EVENT,
  canDeleteAttachment,
  cleanupAttachmentObjects,
  MAX_RECORD_IMAGES,
  queueAttachmentCleanup,
  NOTES_CHANGED_EVENT,
  requireAttachmentWrite,
  thumbnailKey,
  type AttachmentParent,
} from '../lib/attachments.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { processAttachmentImage } from '../lib/images.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';
import { storage } from '../lib/storage.js';

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES, files: 1, fields: 0, parts: 2 },
}).single('file');
const upload: RequestHandler = (req, res, next) =>
  multipart(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError)
      return next(
        new AppError(
          err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
          'UPLOAD_INVALID',
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Images must not exceed 10 MB'
            : 'Upload one image using the file field, with no other fields',
        ),
      );
    next(err ? new AppError(400, 'UPLOAD_INVALID', 'Malformed image upload') : undefined);
  });

export function attachmentsRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };
  const changed = (hid: string, parent: AttachmentParent) => {
    realtime.publish(hid, { type: ATTACHMENTS_CHANGED_EVENT, entityId: parent.taskId ?? parent.noteId });
    realtime.publish(hid, {
      type: parent.taskId ? 'tasks.changed' : NOTES_CHANGED_EVENT,
      entityId: parent.taskId ?? parent.noteId,
    });
  };

  for (const kind of ['tasks', 'notes'] as const) {
    const parentFrom = (req: Request): AttachmentParent =>
      kind === 'tasks' ? { taskId: req.params.parentId! } : { noteId: req.params.parentId! };
    const authorize: RequestHandler = (req, _res, next) => {
      attachmentParent(prisma, ctx(req), parentFrom(req))
        .then((p) => {
          requireAttachmentWrite(p.canWrite);
          next();
        })
        .catch(next);
    };
    route(
      m,
      {
        method: 'get',
        path: `/${kind}/:parentId/attachments`,
        summary: `List ${kind} images and allowed actions`,
        tags: ['Attachments'],
      },
      async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const c = ctx(req);
        const parent = parentFrom(req);
        const p = await attachmentParent(prisma, c, parent);
        const rows = await prisma.attachment.findMany({
          where: { householdId: c.householdId, ...parent },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        return {
          items: rows.map(attachmentDTO),
          canUpload: p.canWrite,
          canDeleteIds: rows.filter((r) => canDeleteAttachment(c, r, p.canWrite)).map((r) => r.id),
        };
      },
    );

    route(
      m,
      {
        method: 'post',
        path: `/${kind}/:parentId/attachments`,
        summary: `Upload one ${kind} image (multipart file, 10 MB, maximum five per record)`,
        tags: ['Attachments'],
        status: 201,
        middleware: [authorize, upload],
      },
      async (req) => {
        const c = ctx(req);
        const parent = parentFrom(req);
        if (!req.file) throw new AppError(400, 'NO_FILE', 'Choose an image');
        const image = await processAttachmentImage(req.file.buffer, req.file.mimetype);
        const id = randomUUID();
        const storageKey = `attachments/${c.householdId}/${id}.webp`;
        let storageAttempted = false;
        let row;
        try {
          row = await prisma.$transaction(
            async (db) => {
              const p = await attachmentParent(db, c, parent, true);
              requireAttachmentWrite(p.canWrite);
              const count = await db.attachment.count({ where: { householdId: c.householdId, ...parent } });
              if (count >= MAX_RECORD_IMAGES) throw conflict('A record can have at most five images');
              storageAttempted = true;
              await storage().put(storageKey, image.full, image.mimeType);
              await storage().put(thumbnailKey(storageKey), image.thumb, image.mimeType);
              const attachment = await db.attachment.create({
                data: {
                  id,
                  householdId: c.householdId,
                  ...parent,
                  storageKey,
                  mimeType: image.mimeType,
                  sizeBytes: image.full.length,
                  width: image.width,
                  height: image.height,
                  uploaderMemberId: c.actor.kind === 'member' ? c.actor.memberId : null,
                  uploaderDeviceId: c.actor.kind === 'device' ? c.actor.deviceId : null,
                },
              });
              if (parent.noteId)
                await db.note.update({ where: { id: parent.noteId }, data: { updatedAt: new Date() } });
              return attachment;
            },
            { timeout: 30_000, maxWait: 30_000 },
          );
        } catch (err) {
          if (storageAttempted) await cleanupAttachmentObjects([{ id, storageKey }]);
          if (err instanceof AppError) throw err;
          throw new AppError(503, 'UPLOAD_FAILED', 'Image could not be saved. Please retry.');
        }
        await audit(req, {
          householdId: c.householdId,
          action: 'attachment.created',
          entityType: 'attachment',
          entityId: row.id,
        });
        changed(c.householdId, parent);
        return attachmentDTO(row);
      },
    );
  }

  const load = async (req: Request) => {
    const id = z.string().uuid().safeParse(req.params.attachmentId);
    if (!id.success) throw notFound('Attachment');
    const row = await prisma.attachment.findFirst({
      where: { id: id.data, householdId: ctx(req).householdId },
    });
    if (!row) throw notFound('Attachment');
    const parent: AttachmentParent = row.taskId ? { taskId: row.taskId } : { noteId: row.noteId! };
    return { row, parent };
  };

  route(
    m,
    {
      method: 'get',
      path: '/attachments/:attachmentId/file',
      summary: 'Read a household-authorized processed image or thumbnail',
      tags: ['Attachments'],
      raw: true,
      query: z.object({ size: z.literal('thumb').optional() }).strict(),
    },
    async (req, res, { query }) => {
      const { row, parent } = await load(req);
      await attachmentParent(prisma, ctx(req), parent);
      let body: Buffer | null;
      try {
        body = await storage().get(query.size === 'thumb' ? thumbnailKey(row.storageKey) : row.storageKey);
      } catch {
        throw new AppError(503, 'IMAGE_UNAVAILABLE', 'Image storage is temporarily unavailable');
      }
      if (!body) throw notFound('Image');
      res.set({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Disposition': 'inline; filename="attachment.webp"',
      });
      res.type('image/webp').send(body);
    },
  );

  route(
    m,
    {
      method: 'delete',
      path: '/attachments/:attachmentId',
      summary: 'Remove an authorized task or note image',
      tags: ['Attachments'],
    },
    async (req) => {
      const c = ctx(req);
      const { row, parent } = await load(req);
      await prisma.$transaction(async (db) => {
        const p = await attachmentParent(db, c, parent, true);
        const current = await db.attachment.findFirst({ where: { householdId: c.householdId, id: row.id } });
        if (!current) throw notFound('Attachment');
        requireAttachmentWrite(canDeleteAttachment(c, current, p.canWrite));
        await queueAttachmentCleanup(db, [current]);
        await db.attachment.delete({ where: { householdId_id: { householdId: c.householdId, id: row.id } } });
        if (parent.noteId)
          await db.note.update({ where: { id: parent.noteId }, data: { updatedAt: new Date() } });
      });
      await cleanupAttachmentObjects([row]);
      await audit(req, {
        householdId: c.householdId,
        action: 'attachment.deleted',
        entityType: 'attachment',
        entityId: row.id,
      });
      changed(c.householdId, parent);
      return undefined;
    },
  );
  return router;
}
