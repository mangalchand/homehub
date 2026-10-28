import { Router } from 'express';
import { z } from 'zod';
import { createNoteSchema, updateNoteSchema } from '@familyhub/shared';
import { ctx, householdContext, requireCap } from '../auth/context.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import {
  attachmentParent,
  cleanupAttachmentObjects,
  noteDTO,
  queueAttachmentCleanup,
  NOTES_CHANGED_EVENT,
  requireAttachmentWrite,
} from '../lib/attachments.js';
import { badRequest } from '../lib/errors.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';

export function notesRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  router.use('/notes', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };
  const attachments = { orderBy: { createdAt: 'asc' as const } };
  const changed = (hid: string, id: string) =>
    realtime.publish(hid, { type: NOTES_CHANGED_EVENT, entityId: id });

  route(
    m,
    {
      method: 'get',
      path: '/notes',
      summary: 'List household notes',
      tags: ['Notes'],
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        before: z.string().uuid().optional(),
      }),
    },
    async (req, _res, { query }) => {
      const householdId = ctx(req).householdId;
      let cursor: { id: string; updatedAt: Date } | null = null;
      if (query.before) {
        cursor = await prisma.note.findFirst({
          where: { householdId, id: query.before },
          select: { id: true, updatedAt: true },
        });
        if (!cursor) throw badRequest('Invalid notes page');
      }
      const rows = await prisma.note.findMany({
        where: {
          householdId,
          ...(cursor
            ? {
                OR: [
                  { updatedAt: { lt: cursor.updatedAt } },
                  { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        include: { attachments },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: query.limit,
      });
      return rows.map(noteDTO);
    },
  );

  route(
    m,
    { method: 'get', path: '/notes/:noteId', summary: 'Read a household note', tags: ['Notes'] },
    async (req) => {
      const c = ctx(req);
      await attachmentParent(prisma, c, { noteId: req.params.noteId! });
      return noteDTO(
        await prisma.note.findUniqueOrThrow({
          where: { householdId_id: { householdId: c.householdId, id: req.params.noteId! } },
          include: { attachments },
        }),
      );
    },
  );

  route(
    m,
    {
      method: 'post',
      path: '/notes',
      summary: 'Create a note (members or paired displays with lists.write)',
      tags: ['Notes'],
      body: createNoteSchema,
      status: 201,
      middleware: [requireCap('lists.write')],
    },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const row = await prisma.note.create({
        data: {
          householdId: c.householdId,
          ...body,
          authorMemberId: c.actor.kind === 'member' ? c.actor.memberId : null,
          authorDeviceId: c.actor.kind === 'device' ? c.actor.deviceId : null,
        },
        include: { attachments },
      });
      await audit(req, {
        householdId: c.householdId,
        action: 'note.created',
        entityType: 'note',
        entityId: row.id,
      });
      changed(c.householdId, row.id);
      return noteDTO(row);
    },
  );

  route(
    m,
    {
      method: 'patch',
      path: '/notes/:noteId',
      summary: 'Edit an own-authored note or administer notes',
      tags: ['Notes'],
      body: updateNoteSchema,
    },
    async (req, _res, { body }) => {
      if (!Object.keys(body).length) throw badRequest('Provide a title or body');
      const c = ctx(req);
      const row = await prisma.$transaction(async (db) => {
        const p = await attachmentParent(db, c, { noteId: req.params.noteId! }, true);
        requireAttachmentWrite(p.canWrite);
        return db.note.update({
          where: { householdId_id: { householdId: c.householdId, id: p.note!.id } },
          data: body,
          include: { attachments },
        });
      });
      await audit(req, {
        householdId: c.householdId,
        action: 'note.updated',
        entityType: 'note',
        entityId: row.id,
      });
      changed(c.householdId, row.id);
      return noteDTO(row);
    },
  );

  route(
    m,
    {
      method: 'delete',
      path: '/notes/:noteId',
      summary: 'Delete an own-authored note or administer notes',
      tags: ['Notes'],
    },
    async (req) => {
      const c = ctx(req);
      const rows = await prisma.$transaction(async (db) => {
        const p = await attachmentParent(db, c, { noteId: req.params.noteId! }, true);
        requireAttachmentWrite(p.canWrite);
        const images = await db.attachment.findMany({
          where: { householdId: c.householdId, noteId: p.note!.id },
        });
        await queueAttachmentCleanup(db, images);
        await db.note.delete({ where: { householdId_id: { householdId: c.householdId, id: p.note!.id } } });
        return images;
      });
      await cleanupAttachmentObjects(rows);
      await audit(req, {
        householdId: c.householdId,
        action: 'note.deleted',
        entityType: 'note',
        entityId: req.params.noteId!,
      });
      changed(c.householdId, req.params.noteId!);
      return undefined;
    },
  );
  return router;
}
