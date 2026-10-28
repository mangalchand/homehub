import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  adjustPointsSchema,
  can,
  completeTaskSchema,
  createRewardSchema,
  createTaskSchema,
  redeemRewardSchema,
  reviewSchema,
  updateRewardSchema,
  updateTaskSchema,
} from '@familyhub/shared';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';
import { assertCap, ctx, householdContext, requireCap } from '../auth/context.js';
import { expandOccurrences, stripRrulePrefix } from '../calendar/recurrence.js';
import { notify } from '../lib/notify.js';
import { attachmentParent, cleanupAttachmentObjects } from '../lib/attachments.js';

const taskInclude = {
  assignments: { orderBy: { position: 'asc' } },
  completions: { orderBy: { completedAt: 'desc' }, take: 50 },
} satisfies Prisma.TaskInclude;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

/** Occurrence info for a chore on a given local date. */
export function occurrenceFor(task: Pick<TaskRow, 'rrule' | 'dueAt' | 'createdAt'>, date: string, tz: string) {
  if (!task.rrule) return { key: 'once', due: true, index: 0 };
  const anchorInstant = task.dueAt ?? task.createdAt;
  const anchorLocal = DateTime.fromJSDate(anchorInstant, { zone: tz }).startOf('day');
  const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day');
  if (dayStart < anchorLocal) return { key: date, due: false, index: -1 };
  const src = { startAt: anchorLocal.toJSDate(), endAt: anchorLocal.toJSDate(), allDay: false, timezone: tz, rrule: task.rrule, exdates: [] };
  const today = expandOccurrences(src, dayStart.toJSDate(), dayStart.plus({ days: 1 }).toJSDate());
  if (!today.length) return { key: date, due: false, index: -1 };
  const index = expandOccurrences(src, anchorLocal.toJSDate(), dayStart.toJSDate(), 100000).length;
  return { key: date, due: true, index };
}

function taskDTO(t: TaskRow, date: string, tz: string) {
  const occ = occurrenceFor(t, date, tz);
  const assignees = t.assignments.map((a) => a.memberId);
  const currentAssignees = t.rotate && assignees.length > 1 && occ.index >= 0 ? [assignees[occ.index % assignees.length]!] : assignees;
  const relevant = t.completions.filter((c) => c.occurrenceKey === occ.key && c.status !== 'REJECTED');
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    description: t.description,
    category: t.category,
    priority: t.priority,
    dueAt: t.dueAt?.toISOString() ?? null,
    rrule: t.rrule,
    points: t.points,
    requiresApproval: t.requiresApproval,
    rotate: t.rotate,
    icon: t.icon,
    checklist: t.checklist,
    status: t.status,
    memberIds: assignees,
    currentAssigneeIds: currentAssignees,
    occurrenceKey: occ.key,
    dueOnDate: occ.due,
    completions: relevant.map((c) => ({ id: c.id, memberId: c.memberId, status: c.status, completedAt: c.completedAt.toISOString(), pointsAwarded: c.pointsAwarded })),
    isOverdue: !t.rrule && t.status === 'OPEN' && Boolean(t.dueAt && t.dueAt < new Date()),
  };
}

export async function pointBalances(householdId: string) {
  const rows = await prisma.rewardTransaction.groupBy({
    by: ['memberId', 'status'],
    where: { householdId, status: { in: ['APPROVED', 'PENDING'] } },
    _sum: { points: true },
  });
  const pendingRedeem = await prisma.rewardTransaction.groupBy({
    by: ['memberId'],
    where: { householdId, status: 'PENDING', type: 'REDEEM' },
    _sum: { points: true },
  });
  const map = new Map<string, { balance: number; pending: number; available: number }>();
  for (const r of rows) {
    const cur = map.get(r.memberId) ?? { balance: 0, pending: 0, available: 0 };
    if (r.status === 'APPROVED') cur.balance += r._sum.points ?? 0;
    else cur.pending += r._sum.points ?? 0;
    map.set(r.memberId, cur);
  }
  for (const [id, v] of map) {
    const reserved = pendingRedeem.find((p) => p.memberId === id)?._sum.points ?? 0;
    v.available = v.balance + reserved; // reserved is negative
  }
  return map;
}

export function tasksRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };
  const localToday = (tz: string) => DateTime.now().setZone(tz).toISODate()!;

  async function assertMembers(householdId: string, ids: string[] | undefined) {
    if (!ids?.length) return;
    const n = await prisma.householdMember.count({ where: { householdId, id: { in: ids } } });
    if (n !== new Set(ids).size) throw badRequest('Assigned members must belong to this household');
  }

  async function loadTask(householdId: string, id: string) {
    const t = await prisma.task.findFirst({ where: { id, householdId, deletedAt: null }, include: taskInclude });
    if (!t) throw notFound('Task');
    return t;
  }

  route(
    m,
    {
      method: 'get', path: '/tasks', summary: 'List tasks and chores (with completion state for a date)', tags: ['Tasks'],
      query: z.object({
        kind: z.enum(['TASK', 'CHORE']).optional(),
        memberId: z.string().uuid().optional(),
        date: z.string().date().optional(),
        includeDone: z.coerce.boolean().default(false),
      }),
    },
    async (req, _res, { query }) => {
      const c = ctx(req);
      const tz = c.household.timezone;
      const date = query.date ?? localToday(tz);
      const rows = await prisma.task.findMany({
        where: {
          householdId: c.householdId,
          deletedAt: null,
          kind: query.kind,
          status: query.includeDone ? { not: 'ARCHIVED' } : 'OPEN',
          ...(query.memberId ? { OR: [{ assignments: { some: { memberId: query.memberId } } }, { assignments: { none: {} } }] } : {}),
        },
        include: taskInclude,
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      });
      let out = rows.map((t) => taskDTO(t, date, tz));
      if (query.memberId) out = out.filter((t) => !t.currentAssigneeIds.length || t.currentAssigneeIds.includes(query.memberId!));
      return out;
    },
  );

  route(
    m,
    { method: 'post', path: '/tasks', summary: 'Create a task or chore (home displays may add simple one-off tasks without the PIN)', tags: ['Tasks'], body: createTaskSchema, status: 201 },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const simpleTask = body.kind === 'TASK' && !body.rrule && body.points === 0 && !body.requiresApproval;
      if (!(can(c.actor, 'tasks.manage') || (c.actor.kind === 'device' && simpleTask))) assertCap(req, 'tasks.manage');
      await assertMembers(c.householdId, body.memberIds);
      const t = await prisma.task.create({
        data: {
          householdId: c.householdId,
          kind: body.kind,
          title: body.title,
          description: body.description ?? null,
          category: body.category ?? null,
          priority: body.priority,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          rrule: body.rrule ? stripRrulePrefix(body.rrule) : null,
          points: body.points,
          requiresApproval: body.requiresApproval,
          rotate: body.rotate,
          icon: body.icon ?? null,
          checklist: body.checklist,
          createdById: c.actor.kind === 'member' ? c.actor.userId : null,
          assignments: { create: body.memberIds.map((memberId, position) => ({ memberId, position })) },
        },
        include: taskInclude,
      });
      await audit(req, { householdId: c.householdId, action: 'task.created', entityType: 'task', entityId: t.id });
      realtime.publish(c.householdId, { type: 'tasks.changed', entityId: t.id });
      void notify(c.householdId, { type: body.kind === 'CHORE' ? 'chore.assigned' : 'task.created', title: body.kind === 'CHORE' ? `New chore: ${body.title}` : `New task: ${body.title}`, body: body.points ? `${body.points} points` : undefined, url: '/chores', householdFeed: true }, { to: body.memberIds.length ? body.memberIds : undefined, except: c.actor.kind === 'member' ? c.actor.memberId : null });
      return taskDTO(t, localToday(c.household.timezone), c.household.timezone);
    },
  );

  route(
    m,
    { method: 'patch', path: '/tasks/:taskId', summary: 'Update a task or chore', tags: ['Tasks'], body: updateTaskSchema },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const t = await loadTask(c.householdId, req.params.taskId!);
      const manager = can(c.actor, 'tasks.manage');
      const onlyChecklist = Object.keys(body).every((k) => k === 'checklist');
      if (!manager && !(onlyChecklist && can(c.actor, 'tasks.complete'))) throw forbidden();
      await assertMembers(c.householdId, body.memberIds);
      const updated = await prisma.task.update({
        where: { id: t.id },
        data: {
          kind: body.kind,
          title: body.title,
          description: body.description,
          category: body.category,
          priority: body.priority,
          dueAt: body.dueAt === undefined ? undefined : body.dueAt ? new Date(body.dueAt) : null,
          rrule: body.rrule === undefined ? undefined : body.rrule ? stripRrulePrefix(body.rrule) : null,
          points: body.points,
          requiresApproval: body.requiresApproval,
          rotate: body.rotate,
          icon: body.icon,
          checklist: body.checklist,
          status: body.status,
          completedAt: body.status === 'DONE' ? new Date() : body.status === 'OPEN' ? null : undefined,
          ...(body.memberIds ? { assignments: { deleteMany: {}, create: body.memberIds.map((memberId, position) => ({ memberId, position })) } } : {}),
        },
        include: taskInclude,
      });
      await audit(req, { householdId: c.householdId, action: 'task.updated', entityType: 'task', entityId: t.id, metadata: { fields: Object.keys(body) } });
      realtime.publish(c.householdId, { type: 'tasks.changed', entityId: t.id });
      return taskDTO(updated, localToday(c.household.timezone), c.household.timezone);
    },
  );

  route(m, { method: 'delete', path: '/tasks/:taskId', summary: 'Delete a task', tags: ['Tasks'], middleware: [requireCap('tasks.manage')] }, async (req) => {
    const c = ctx(req);
    const t = await loadTask(c.householdId, req.params.taskId!);
    const images = await prisma.$transaction(async (db) => {
      await attachmentParent(db, c, { taskId: t.id }, true);
      const rows = await db.attachment.findMany({ where: { householdId: c.householdId, taskId: t.id } });
      await db.task.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
      await db.attachment.deleteMany({ where: { householdId: c.householdId, taskId: t.id } });
      return rows;
    });
    await cleanupAttachmentObjects(images);
    await audit(req, { householdId: c.householdId, action: 'task.deleted', entityType: 'task', entityId: t.id });
    realtime.publish(c.householdId, { type: 'tasks.changed', entityId: t.id });
    return undefined;
  });

  route(
    m,
    { method: 'post', path: '/tasks/:taskId/complete', summary: 'Mark a task/chore complete for a member', tags: ['Tasks'], body: completeTaskSchema, status: 201, middleware: [requireCap('tasks.complete')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const tz = c.household.timezone;
      const t = await loadTask(c.householdId, req.params.taskId!);
      const member = await prisma.householdMember.findFirst({ where: { id: body.memberId, householdId: c.householdId, isActive: true } });
      if (!member) throw badRequest('Unknown member');
      const isSelf = c.actor.kind === 'member' && c.actor.memberId === member.id;
      if (c.actor.kind === 'member' && !isSelf && !can(c.actor, 'tasks.manage')) throw forbidden('You can only complete your own chores');
      const assignees = t.assignments.map((a) => a.memberId);
      if (assignees.length && !assignees.includes(member.id)) throw unprocessable('NOT_ASSIGNED', `${member.displayName} is not assigned to this chore`);
      const date = body.occurrenceDate ?? localToday(tz);
      const occ = occurrenceFor(t, date, tz);
      if (!occ.due) throw unprocessable('NOT_DUE', 'This chore is not scheduled for that day');
      const needsApproval = t.requiresApproval && !(c.actor.kind === 'member' && can(c.actor, 'chores.approve'));
      const status = needsApproval ? 'PENDING_APPROVAL' : 'APPROVED';
      try {
        const completion = await prisma.$transaction(async (tx) => {
          const comp = await tx.choreCompletion.create({
            data: { householdId: c.householdId, taskId: t.id, memberId: member.id, occurrenceKey: occ.key, status, pointsAwarded: t.points },
          });
          if (t.points > 0) {
            await tx.rewardTransaction.create({
              data: {
                householdId: c.householdId, memberId: member.id, type: 'EARN', status: needsApproval ? 'PENDING' : 'APPROVED',
                points: t.points, choreCompletionId: comp.id, note: t.title, createdById: c.actor.kind === 'member' ? c.actor.userId : null,
              },
            });
          }
          if (!t.rrule && !needsApproval) await tx.task.update({ where: { id: t.id }, data: { status: 'DONE', completedAt: new Date() } });
          return comp;
        });
        await audit(req, { householdId: c.householdId, action: 'task.completed', entityType: 'task', entityId: t.id, metadata: { memberId: member.id, status } });
        realtime.publish(c.householdId, { type: 'tasks.changed', entityId: t.id });
        if (t.points) realtime.publish(c.householdId, { type: 'points.changed', entityId: member.id });
        return { id: completion.id, status: completion.status, pointsAwarded: completion.pointsAwarded, needsApproval };
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') throw conflict('Already completed');
        throw e;
      }
    },
  );

  route(m, { method: 'delete', path: '/completions/:completionId', summary: 'Undo a completion', tags: ['Tasks'], middleware: [requireCap('tasks.complete')] }, async (req) => {
    const c = ctx(req);
    const comp = await prisma.choreCompletion.findFirst({ where: { id: req.params.completionId, householdId: c.householdId }, include: { task: true } });
    if (!comp) throw notFound('Completion');
    const isSelf = c.actor.kind === 'member' && c.actor.memberId === comp.memberId;
    const recent = Date.now() - comp.completedAt.getTime() < 15 * 60000;
    if (!can(c.actor, 'tasks.manage') && !((isSelf || c.actor.kind === 'device') && recent)) {
      throw forbidden('Ask a parent to undo this');
    }
    await prisma.$transaction([
      prisma.choreCompletion.delete({ where: { id: comp.id } }),
      ...(comp.task.rrule ? [] : [prisma.task.update({ where: { id: comp.taskId }, data: { status: 'OPEN', completedAt: null } })]),
    ]);
    await audit(req, { householdId: c.householdId, action: 'task.completion_undone', entityType: 'task', entityId: comp.taskId });
    realtime.publish(c.householdId, { type: 'tasks.changed', entityId: comp.taskId });
    realtime.publish(c.householdId, { type: 'points.changed', entityId: comp.memberId });
    return undefined;
  });

  route(m, { method: 'get', path: '/approvals', summary: 'Chore completions and reward redemptions waiting for a parent', tags: ['Rewards'], middleware: [requireCap('chores.approve')] }, async (req) => {
    const c = ctx(req);
    const [chores, redemptions] = await Promise.all([
      prisma.choreCompletion.findMany({
        where: { householdId: c.householdId, status: 'PENDING_APPROVAL' },
        include: { task: { select: { title: true, icon: true } } },
        orderBy: { completedAt: 'asc' },
      }),
      prisma.rewardTransaction.findMany({
        where: { householdId: c.householdId, status: 'PENDING', type: 'REDEEM' },
        include: { reward: { select: { title: true, icon: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      chores: chores.map((x) => ({ id: x.id, taskId: x.taskId, title: x.task.title, icon: x.task.icon, memberId: x.memberId, points: x.pointsAwarded, completedAt: x.completedAt })),
      redemptions: redemptions.map((x) => ({ id: x.id, rewardId: x.rewardId, title: x.reward?.title ?? x.note, icon: x.reward?.icon ?? null, memberId: x.memberId, points: -x.points, createdAt: x.createdAt })),
    };
  });

  route(
    m,
    { method: 'post', path: '/completions/:completionId/review', summary: 'Approve or reject a chore completion', tags: ['Rewards'], body: reviewSchema, middleware: [requireCap('chores.approve')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const comp = await prisma.choreCompletion.findFirst({ where: { id: req.params.completionId, householdId: c.householdId, status: 'PENDING_APPROVAL' }, include: { task: true } });
      if (!comp) throw notFound('Pending completion');
      const reviewer = c.actor.kind === 'member' ? c.actor.userId : null;
      await prisma.$transaction([
        prisma.choreCompletion.update({ where: { id: comp.id }, data: { status: body.approve ? 'APPROVED' : 'REJECTED', reviewedById: reviewer, reviewedAt: new Date() } }),
        prisma.rewardTransaction.updateMany({ where: { choreCompletionId: comp.id }, data: { status: body.approve ? 'APPROVED' : 'REJECTED', reviewedById: reviewer, reviewedAt: new Date() } }),
        ...(!comp.task.rrule && body.approve ? [prisma.task.update({ where: { id: comp.taskId }, data: { status: 'DONE', completedAt: new Date() } })] : []),
      ]);
      // A rejected chore can be redone: free the unique slot.
      if (!body.approve) await prisma.choreCompletion.update({ where: { id: comp.id }, data: { occurrenceKey: `${comp.occurrenceKey}#rejected-${comp.id}` } });
      await audit(req, { householdId: c.householdId, action: body.approve ? 'chore.approved' : 'chore.rejected', entityType: 'chore_completion', entityId: comp.id });
      realtime.publish(c.householdId, { type: 'tasks.changed', entityId: comp.taskId });
      realtime.publish(c.householdId, { type: 'points.changed', entityId: comp.memberId });
      return { ok: true };
    },
  );

  // ── Rewards & points ──
  route(m, { method: 'get', path: '/rewards', summary: 'List rewards', tags: ['Rewards'] }, async (req) => {
    const c = ctx(req);
    return prisma.reward.findMany({ where: { householdId: c.householdId, ...(can(c.actor, 'rewards.manage') ? {} : { isActive: true }) }, orderBy: { cost: 'asc' } });
  });

  route(m, { method: 'post', path: '/rewards', summary: 'Create a reward', tags: ['Rewards'], body: createRewardSchema, status: 201, middleware: [requireCap('rewards.manage')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const r = await prisma.reward.create({ data: { householdId: c.householdId, title: body.title, description: body.description ?? null, icon: body.icon ?? null, cost: body.cost, isActive: body.isActive } });
    realtime.publish(c.householdId, { type: 'rewards.changed' });
    return r;
  });

  route(m, { method: 'patch', path: '/rewards/:rewardId', summary: 'Update a reward', tags: ['Rewards'], body: updateRewardSchema, middleware: [requireCap('rewards.manage')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const r = await prisma.reward.updateMany({ where: { id: req.params.rewardId, householdId: c.householdId }, data: body });
    if (!r.count) throw notFound('Reward');
    realtime.publish(c.householdId, { type: 'rewards.changed' });
    return prisma.reward.findUniqueOrThrow({ where: { id: req.params.rewardId } });
  });

  route(m, { method: 'delete', path: '/rewards/:rewardId', summary: 'Delete a reward', tags: ['Rewards'], middleware: [requireCap('rewards.manage')] }, async (req) => {
    const c = ctx(req);
    const r = await prisma.reward.deleteMany({ where: { id: req.params.rewardId, householdId: c.householdId } });
    if (!r.count) throw notFound('Reward');
    realtime.publish(c.householdId, { type: 'rewards.changed' });
    return undefined;
  });

  route(
    m,
    { method: 'post', path: '/rewards/:rewardId/redeem', summary: 'Request a reward (a parent approves)', tags: ['Rewards'], body: redeemRewardSchema, status: 201, middleware: [requireCap('rewards.redeem')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const reward = await prisma.reward.findFirst({ where: { id: req.params.rewardId, householdId: c.householdId, isActive: true } });
      if (!reward) throw notFound('Reward');
      if (c.actor.kind === 'member' && c.actor.memberId !== body.memberId && !can(c.actor, 'rewards.manage')) throw forbidden('You can only redeem rewards for yourself');
      const member = await prisma.householdMember.findFirst({ where: { id: body.memberId, householdId: c.householdId } });
      if (!member) throw badRequest('Unknown member');
      // Serialize redemptions per member so concurrent requests cannot overspend.
      const tx = await prisma.$transaction(async (db) => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${member.id}))`;
        const agg = await db.rewardTransaction.aggregate({
          where: { memberId: member.id, OR: [{ status: 'APPROVED' }, { status: 'PENDING', type: 'REDEEM' }] },
          _sum: { points: true },
        });
        const available = agg._sum.points ?? 0;
        if (available < reward.cost) throw unprocessable('INSUFFICIENT_POINTS', `Needs ${reward.cost} points; ${member.displayName} has ${available} available`);
        return db.rewardTransaction.create({
          data: {
            householdId: c.householdId, memberId: member.id, type: 'REDEEM', status: 'PENDING', points: -reward.cost, rewardId: reward.id,
            note: reward.title, createdById: c.actor.kind === 'member' ? c.actor.userId : null,
          },
        });
      });
      await audit(req, { householdId: c.householdId, action: 'reward.redeem_requested', entityType: 'reward', entityId: reward.id, metadata: { memberId: member.id } });
      realtime.publish(c.householdId, { type: 'points.changed', entityId: member.id });
      const parents = await prisma.householdMember.findMany({ where: { householdId: c.householdId, role: { in: ['OWNER', 'ADULT_ADMIN', 'ADULT'] } }, select: { id: true } });
      void notify(c.householdId, { type: 'reward.requested', title: `${member.displayName} wants “${reward.title}”`, body: `${reward.cost} points · approve in Rewards`, url: '/rewards' }, { to: parents.map((p) => p.id) });
      return { id: tx.id, status: tx.status };
    },
  );

  route(
    m,
    { method: 'post', path: '/redemptions/:transactionId/review', summary: 'Approve or decline a reward redemption', tags: ['Rewards'], body: reviewSchema, middleware: [requireCap('chores.approve')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const r = await prisma.rewardTransaction.updateMany({
        where: { id: req.params.transactionId, householdId: c.householdId, type: 'REDEEM', status: 'PENDING' },
        data: { status: body.approve ? 'APPROVED' : 'REJECTED', reviewedById: c.actor.kind === 'member' ? c.actor.userId : null, reviewedAt: new Date() },
      });
      if (!r.count) throw notFound('Pending redemption');
      await audit(req, { householdId: c.householdId, action: body.approve ? 'reward.redeem_approved' : 'reward.redeem_rejected', entityType: 'reward_transaction', entityId: req.params.transactionId });
      realtime.publish(c.householdId, { type: 'points.changed' });
      return { ok: true };
    },
  );

  route(m, { method: 'post', path: '/points/adjust', summary: 'Manually add or remove points', tags: ['Rewards'], body: adjustPointsSchema, status: 201, middleware: [requireCap('rewards.manage')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const member = await prisma.householdMember.findFirst({ where: { id: body.memberId, householdId: c.householdId } });
    if (!member) throw badRequest('Unknown member');
    const tx = await prisma.rewardTransaction.create({
      data: { householdId: c.householdId, memberId: member.id, type: 'ADJUST', status: 'APPROVED', points: body.points, note: body.note ?? null, createdById: c.actor.kind === 'member' ? c.actor.userId : null },
    });
    await audit(req, { householdId: c.householdId, action: 'points.adjusted', entityType: 'member', entityId: member.id, metadata: { points: body.points } });
    realtime.publish(c.householdId, { type: 'points.changed', entityId: member.id });
    return tx;
  });

  route(m, { method: 'get', path: '/points', summary: 'Point balances for all members', tags: ['Rewards'] }, async (req) => {
    const c = ctx(req);
    const balances = await pointBalances(c.householdId);
    const members = await prisma.householdMember.findMany({ where: { householdId: c.householdId, isActive: true }, select: { id: true } });
    return members.map((mm) => ({ memberId: mm.id, ...(balances.get(mm.id) ?? { balance: 0, pending: 0, available: 0 }) }));
  });

  route(m, { method: 'get', path: '/members/:memberId/points/history', summary: 'Point history for a member', tags: ['Rewards'] }, async (req) => {
    const c = ctx(req);
    const isSelf = c.actor.kind === 'member' && c.actor.memberId === req.params.memberId;
    if (!isSelf && c.actor.kind === 'member' && (c.actor.role === 'CHILD' || c.actor.role === 'GUEST')) throw forbidden();
    return prisma.rewardTransaction.findMany({
      where: { householdId: c.householdId, memberId: req.params.memberId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, type: true, status: true, points: true, note: true, createdAt: true },
    });
  });

  return router;
}
