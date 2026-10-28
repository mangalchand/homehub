import type { Attachment, Note, Prisma, Task } from '@prisma/client';
import { can, type AttachmentDTO, type NoteDTO } from '@familyhub/shared';
import type { HouseholdContext } from '../auth/context.js';
import { forbidden, notFound } from './errors.js';
import { storage } from './storage.js';
import { logger } from '../logger.js';

export const MAX_RECORD_IMAGES = 5;
export const ATTACHMENTS_CHANGED_EVENT = 'attachments.changed';
export const NOTES_CHANGED_EVENT = 'notes.changed';
export type AttachmentParent = { taskId: string; noteId?: never } | { noteId: string; taskId?: never };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canEditNote(c: HouseholdContext, note: Note) {
  if (!can(c.actor, 'lists.write')) return false;
  return (
    can(c.actor, 'members.manage') ||
    (c.actor.kind === 'member'
      ? note.authorMemberId === c.actor.memberId
      : note.authorDeviceId === c.actor.deviceId)
  );
}

export function canAttachToTask(c: HouseholdContext, task: Task) {
  return (
    can(c.actor, 'tasks.manage') ||
    (c.actor.kind === 'device' &&
      task.createdById === null &&
      task.kind === 'TASK' &&
      !task.rrule &&
      task.points === 0 &&
      !task.requiresApproval)
  );
}

/** Parent row locks serialize count checks, uploads and parent deletion. */
export async function attachmentParent(
  db: Prisma.TransactionClient,
  c: HouseholdContext,
  parent: AttachmentParent,
  lock = false,
) {
  const id = parent.taskId ?? parent.noteId;
  if (!uuid.test(id)) throw notFound('Record');
  if (parent.taskId) {
    if (lock)
      await db.$queryRaw`SELECT id FROM tasks WHERE id = ${id}::uuid AND household_id = ${c.householdId}::uuid FOR UPDATE`;
    const task = await db.task.findFirst({ where: { id, householdId: c.householdId, deletedAt: null } });
    if (!task) throw notFound('Task');
    return { canWrite: canAttachToTask(c, task), task, note: null };
  }
  if (lock)
    await db.$queryRaw`SELECT id FROM notes WHERE id = ${id}::uuid AND household_id = ${c.householdId}::uuid FOR UPDATE`;
  const note = await db.note.findFirst({ where: { id, householdId: c.householdId } });
  if (!note) throw notFound('Note');
  return { canWrite: canEditNote(c, note), task: null, note };
}

export function requireAttachmentWrite(allowed: boolean) {
  if (!allowed)
    throw forbidden(
      'Only the note author or an admin may edit note images. Task images require task management permission; shared displays may add images to display-created simple tasks. Enter the household PIN for chores.',
    );
}

export function canDeleteAttachment(c: HouseholdContext, row: Attachment, parentWritable: boolean) {
  if (!parentWritable) return false;
  return (
    row.noteId !== null ||
    can(c.actor, 'tasks.manage') ||
    (c.actor.kind === 'device' && row.uploaderDeviceId === c.actor.deviceId)
  );
}

export function attachmentDTO(a: Attachment): AttachmentDTO {
  const parent = a.taskId
    ? ({ taskId: a.taskId, noteId: null } as const)
    : ({ taskId: null, noteId: a.noteId! } as const);
  return {
    id: a.id,
    householdId: a.householdId,
    ...parent,
    uploaderMemberId: a.uploaderMemberId,
    uploaderDeviceId: a.uploaderDeviceId,
    mimeType: a.mimeType as AttachmentDTO['mimeType'],
    sizeBytes: a.sizeBytes,
    width: a.width,
    height: a.height,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function noteDTO(n: Note & { attachments: Attachment[] }): NoteDTO {
  return {
    id: n.id,
    householdId: n.householdId,
    title: n.title,
    body: n.body,
    authorMemberId: n.authorMemberId,
    authorDeviceId: n.authorDeviceId,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    attachments: n.attachments.map(attachmentDTO),
  };
}

export const thumbnailKey = (key: string) => `${key}.thumb.webp`;

/** Retry transient storage failures without exposing storage keys or vendor error details. */
export async function cleanupAttachmentObjects(rows: Pick<Attachment, 'id' | 'storageKey'>[]) {
  let complete = true;
  for (const row of rows) {
    for (const key of [row.storageKey, thumbnailKey(row.storageKey)]) {
      let removed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await storage().remove(key);
          removed = true;
          break;
        } catch {
          /* Retry idempotent object deletion. */
        }
      }
      if (!removed) {
        complete = false;
        logger.error(
          { attachmentId: row.id },
          'Attachment object cleanup failed; storage reconciliation required',
        );
      }
    }
  }
  return complete;
}
