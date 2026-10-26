import { Router } from 'express';
import { z } from 'zod';
import type { ListItem, Prisma } from '@prisma/client';
import {
  createAnnouncementSchema,
  createListItemSchema,
  createListSchema,
  updateAnnouncementSchema,
  updateListItemSchema,
  updateListSchema,
  upsertDashboardLayoutSchema,
} from '@familyhub/shared';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { categorizeGrocery } from '../lib/grocery.js';
import { openSseStream, realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';
import { ctx, householdContext, requireCap } from '../auth/context.js';
import { notify } from '../lib/notify.js';

function itemDTO(i: ListItem) {
  return {
    id: i.id, listId: i.listId, name: i.name, quantity: i.quantity, unit: i.unit, category: i.category, notes: i.notes,
    priceEstimateCents: i.priceEstimateCents, isDone: i.isDone, doneAt: i.doneAt?.toISOString() ?? null, doneByMemberId: i.doneByMemberId,
    sortOrder: i.sortOrder, version: i.version, updatedAt: i.updatedAt.toISOString(),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Prevent spreadsheet formula injection and escape quotes.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function homeRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };

  // ── Realtime ──
  route(m, { method: 'get', path: '/stream', summary: 'Server-sent events for live household updates', tags: ['Realtime'], raw: true }, (req, res) => {
    const c = ctx(req);
    openSseStream(res, c.householdId, undefined, c.actor.kind === 'member' ? c.actor.memberId : c.actor.deviceId);
  });

  // ── Lists ──
  async function loadList(householdId: string, id: string) {
    const list = await prisma.list.findFirst({ where: { id, householdId, deletedAt: null } });
    if (!list) throw notFound('List');
    return list;
  }
  const publishList = (householdId: string, listId: string) => realtime.publish(householdId, { type: 'lists.changed', entityId: listId });

  route(m, { method: 'get', path: '/lists', summary: 'Lists with item counts', tags: ['Lists'] }, async (req) => {
    const c = ctx(req);
    const lists = await prisma.list.findMany({ where: { householdId: c.householdId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    const counts = await prisma.listItem.groupBy({ by: ['listId', 'isDone'], where: { householdId: c.householdId, deletedAt: null }, _count: true });
    return lists.map((l) => ({
      ...l,
      openCount: counts.find((x) => x.listId === l.id && !x.isDone)?._count ?? 0,
      doneCount: counts.find((x) => x.listId === l.id && x.isDone)?._count ?? 0,
    }));
  });

  route(m, { method: 'post', path: '/lists', summary: 'Create a list', tags: ['Lists'], body: createListSchema, status: 201, middleware: [requireCap('lists.write')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const list = await prisma.list.create({ data: { householdId: c.householdId, name: body.name, type: body.type, icon: body.icon ?? null, color: body.color ?? null, isTemplate: body.isTemplate } });
    publishList(c.householdId, list.id);
    await notify(c.householdId, { type: 'list.created', title: `New list: ${list.name}`, url: `/lists/${list.id}` }, { except: c.actor.kind === 'member' ? c.actor.memberId : null });
    return list;
  });

  route(m, { method: 'get', path: '/lists/:listId', summary: 'Get a list with its items', tags: ['Lists'], query: z.object({ since: z.string().datetime().optional() }) }, async (req, _res, { query }) => {
    const c = ctx(req);
    const list = await loadList(c.householdId, req.params.listId!);
    const items = await prisma.listItem.findMany({
      where: { listId: list.id, ...(query.since ? { updatedAt: { gt: new Date(query.since) } } : { deletedAt: null }) },
      orderBy: [{ isDone: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { ...list, items: items.map((i) => ({ ...itemDTO(i), deleted: Boolean(i.deletedAt) })), serverTime: new Date().toISOString() };
  });

  route(m, { method: 'patch', path: '/lists/:listId', summary: 'Update a list', tags: ['Lists'], body: updateListSchema, middleware: [requireCap('lists.write')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const list = await loadList(c.householdId, req.params.listId!);
    const updated = await prisma.list.update({ where: { id: list.id }, data: body });
    publishList(c.householdId, list.id);
    return updated;
  });

  route(m, { method: 'delete', path: '/lists/:listId', summary: 'Delete a list', tags: ['Lists'], middleware: [requireCap('lists.write')] }, async (req) => {
    const c = ctx(req);
    if (c.actor.kind === 'member' && (c.actor.role === 'CHILD' || c.actor.role === 'GUEST')) throw forbidden('Ask a parent to delete lists');
    const list = await loadList(c.householdId, req.params.listId!);
    await prisma.list.update({ where: { id: list.id }, data: { deletedAt: new Date() } });
    await audit(req, { householdId: c.householdId, action: 'list.deleted', entityType: 'list', entityId: list.id });
    publishList(c.householdId, list.id);
    return undefined;
  });

  route(
    m,
    { method: 'post', path: '/lists/:listId/duplicate', summary: 'Create a new list from a list or template', tags: ['Lists'], body: z.object({ name: z.string().trim().min(1).max(80) }), status: 201, middleware: [requireCap('lists.write')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const src = await loadList(c.householdId, req.params.listId!);
      const items = await prisma.listItem.findMany({ where: { listId: src.id, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
      const list = await prisma.list.create({
        data: {
          householdId: c.householdId, name: body.name, type: src.type, icon: src.icon, color: src.color,
          items: {
            create: items.map((i) => ({
              id: crypto.randomUUID(), householdId: c.householdId, name: i.name, quantity: i.quantity, unit: i.unit, category: i.category, notes: i.notes, sortOrder: i.sortOrder,
            })),
          },
        },
      });
      publishList(c.householdId, list.id);
      return list;
    },
  );

  route(m, { method: 'get', path: '/lists/:listId/export.csv', summary: 'Export a list as CSV', tags: ['Lists'], raw: true }, async (req, res) => {
    const c = ctx(req);
    const list = await loadList(c.householdId, req.params.listId!);
    const items = await prisma.listItem.findMany({ where: { listId: list.id, deletedAt: null }, orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }] });
    const rows = [['Item', 'Quantity', 'Unit', 'Category', 'Notes', 'Done'], ...items.map((i) => [i.name, i.quantity, i.unit, i.category, i.notes, i.isDone ? 'yes' : 'no'])];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${list.name.replace(/[^\w.-]+/g, '_')}.csv"`);
    res.send(rows.map((r) => r.map(csvCell).join(',')).join('\n'));
  });

  route(
    m,
    { method: 'post', path: '/lists/:listId/items', summary: 'Add an item (idempotent on client-generated id)', tags: ['Lists'], body: createListItemSchema, status: 201, middleware: [requireCap('lists.write')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const list = await loadList(c.householdId, req.params.listId!);
      const existing = await prisma.listItem.findUnique({ where: { id: body.id } });
      if (existing) {
        if (existing.householdId !== c.householdId) throw conflict('Item id already in use');
        return itemDTO(existing);
      }
      const max = await prisma.listItem.aggregate({ where: { listId: list.id }, _max: { sortOrder: true } });
      const item = await prisma.listItem.create({
        data: {
          id: body.id, householdId: c.householdId, listId: list.id, name: body.name, quantity: body.quantity ?? null, unit: body.unit ?? null,
          category: body.category ?? (list.type === 'GROCERY' ? categorizeGrocery(body.name) : null), notes: body.notes ?? null,
          priceEstimateCents: body.priceEstimateCents ?? null, isDone: body.isDone ?? false, sortOrder: body.sortOrder ?? (max._max.sortOrder ?? 0) + 1,
        },
      });
      publishList(c.householdId, list.id);
      await notify(c.householdId, { type: 'list.item_added', title: `Added to ${list.name}`, body: item.name, url: `/lists/${list.id}` }, { except: c.actor.kind === 'member' ? c.actor.memberId : null, dedupeKey: `listadd:${item.id}` });
      return itemDTO(item);
    },
  );

  route(
    m,
    { method: 'patch', path: '/lists/:listId/items/:itemId', summary: 'Update an item (optimistic concurrency via expectedVersion)', tags: ['Lists'], body: updateListItemSchema, middleware: [requireCap('lists.write')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const item = await prisma.listItem.findFirst({ where: { id: req.params.itemId, listId: req.params.listId, householdId: c.householdId } });
      if (!item || item.deletedAt) throw notFound('Item');
      const { expectedVersion, ...fields } = body;
      // Toggling done is commutative-friendly; only field edits are rejected on stale versions.
      const onlyDone = Object.keys(fields).every((k) => k === 'isDone');
      if (expectedVersion !== undefined && expectedVersion !== item.version && !onlyDone) {
        throw conflict('This item was changed on another device', { current: itemDTO(item) });
      }
      const memberId = c.actor.kind === 'member' ? c.actor.memberId : null;
      const updated = await prisma.listItem.update({
        where: { id: item.id },
        data: {
          ...fields,
          ...(fields.isDone !== undefined ? { doneAt: fields.isDone ? new Date() : null, doneByMemberId: fields.isDone ? memberId : null } : {}),
          version: { increment: 1 },
        },
      });
      publishList(c.householdId, item.listId);
      return itemDTO(updated);
    },
  );

  route(m, { method: 'delete', path: '/lists/:listId/items/:itemId', summary: 'Remove an item', tags: ['Lists'], middleware: [requireCap('lists.write')] }, async (req) => {
    const c = ctx(req);
    const r = await prisma.listItem.updateMany({
      where: { id: req.params.itemId, listId: req.params.listId, householdId: c.householdId, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    if (r.count) publishList(c.householdId, req.params.listId!);
    return undefined; // idempotent for offline replays
  });

  route(m, { method: 'post', path: '/lists/:listId/clear-done', summary: 'Remove all completed items', tags: ['Lists'], middleware: [requireCap('lists.write')] }, async (req) => {
    const c = ctx(req);
    const list = await loadList(c.householdId, req.params.listId!);
    const r = await prisma.listItem.updateMany({ where: { listId: list.id, isDone: true, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    publishList(c.householdId, list.id);
    return { removed: r.count };
  });

  // ── Announcements ──
  route(m, { method: 'get', path: '/announcements', summary: 'Active announcements', tags: ['Announcements'] }, async (req) => {
    const c = ctx(req);
    return prisma.announcement.findMany({
      where: { householdId: c.householdId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
  });

  route(m, { method: 'post', path: '/announcements', summary: 'Post an announcement', tags: ['Announcements'], body: createAnnouncementSchema, status: 201, middleware: [requireCap('announcements.write')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const a = await prisma.announcement.create({
      data: {
        householdId: c.householdId, title: body.title, body: body.body ?? null, priority: body.priority, color: body.color ?? null, pinned: body.pinned,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, authorId: c.actor.kind === 'member' ? c.actor.memberId : null,
      },
    });
    realtime.publish(c.householdId, { type: 'announcements.changed' });
    void notify(c.householdId, { type: 'announcement', title: body.priority === 'URGENT' ? `Urgent: ${body.title}` : body.title, body: body.body ?? undefined, url: '/' }, { except: c.actor.kind === 'member' ? c.actor.memberId : null });
    return a;
  });

  route(m, { method: 'patch', path: '/announcements/:id', summary: 'Edit an announcement', tags: ['Announcements'], body: updateAnnouncementSchema, middleware: [requireCap('announcements.write')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const r = await prisma.announcement.updateMany({
      where: { id: req.params.id, householdId: c.householdId },
      data: { ...body, expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt ? new Date(body.expiresAt) : null },
    });
    if (!r.count) throw notFound('Announcement');
    realtime.publish(c.householdId, { type: 'announcements.changed' });
    return prisma.announcement.findUniqueOrThrow({ where: { id: req.params.id } });
  });

  route(m, { method: 'delete', path: '/announcements/:id', summary: 'Delete an announcement', tags: ['Announcements'], middleware: [requireCap('announcements.write')] }, async (req) => {
    const c = ctx(req);
    await prisma.announcement.deleteMany({ where: { id: req.params.id, householdId: c.householdId } });
    realtime.publish(c.householdId, { type: 'announcements.changed' });
    return undefined;
  });

  // ── Dashboard layouts ──
  route(m, { method: 'get', path: '/dashboard-layouts', summary: 'Dashboard layouts', tags: ['Dashboard'] }, async (req) => {
    const c = ctx(req);
    return prisma.dashboardLayout.findMany({ where: { householdId: c.householdId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  });

  route(m, { method: 'get', path: '/dashboard-layouts/active', summary: 'Layout for this device (or the household default)', tags: ['Dashboard'] }, async (req) => {
    const c = ctx(req);
    const deviceId = c.actor.kind === 'device' ? c.actor.deviceId : null;
    const layout =
      (deviceId && (await prisma.dashboardLayout.findFirst({ where: { householdId: c.householdId, deviceId } }))) ||
      (await prisma.dashboardLayout.findFirst({ where: { householdId: c.householdId, isDefault: true } })) ||
      (await prisma.dashboardLayout.findFirst({ where: { householdId: c.householdId }, orderBy: { createdAt: 'asc' } }));
    if (!layout) throw notFound('Dashboard layout');
    return layout;
  });

  async function saveLayout(householdId: string, id: string | null, body: z.infer<typeof upsertDashboardLayoutSchema>) {
    if (body.deviceId) {
      const d = await prisma.device.count({ where: { id: body.deviceId, householdId } });
      if (!d) throw notFound('Device');
    }
    return prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.dashboardLayout.updateMany({ where: { householdId }, data: { isDefault: false } });
      const data = { name: body.name, preset: body.preset, widgets: body.widgets as unknown as Prisma.InputJsonValue, isDefault: body.isDefault, deviceId: body.deviceId ?? null };
      if (!id) return tx.dashboardLayout.create({ data: { ...data, householdId } });
      const r = await tx.dashboardLayout.updateMany({ where: { id, householdId }, data });
      if (!r.count) throw notFound('Dashboard layout');
      return tx.dashboardLayout.findUniqueOrThrow({ where: { id } });
    });
  }

  route(m, { method: 'post', path: '/dashboard-layouts', summary: 'Create a dashboard layout', tags: ['Dashboard'], body: upsertDashboardLayoutSchema, status: 201, middleware: [requireCap('dashboard.manage')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const l = await saveLayout(c.householdId, null, body);
    realtime.publish(c.householdId, { type: 'dashboard.changed' });
    return l;
  });

  route(m, { method: 'put', path: '/dashboard-layouts/:layoutId', summary: 'Replace a dashboard layout', tags: ['Dashboard'], body: upsertDashboardLayoutSchema, middleware: [requireCap('dashboard.manage')] }, async (req, _res, { body }) => {
    const c = ctx(req);
    const l = await saveLayout(c.householdId, req.params.layoutId!, body);
    realtime.publish(c.householdId, { type: 'dashboard.changed' });
    return l;
  });

  route(m, { method: 'delete', path: '/dashboard-layouts/:layoutId', summary: 'Delete a dashboard layout', tags: ['Dashboard'], middleware: [requireCap('dashboard.manage')] }, async (req) => {
    const c = ctx(req);
    const total = await prisma.dashboardLayout.count({ where: { householdId: c.householdId } });
    if (total <= 1) throw conflict('Keep at least one dashboard layout');
    await prisma.dashboardLayout.deleteMany({ where: { id: req.params.layoutId, householdId: c.householdId } });
    realtime.publish(c.householdId, { type: 'dashboard.changed' });
    return undefined;
  });

  // ── Notifications ──
  route(m, { method: 'get', path: '/notifications', summary: 'In-app notifications for the current member', tags: ['Notifications'] }, async (req) => {
    const c = ctx(req);
    if (c.actor.kind === 'device') {
      const rows = await prisma.notification.findMany({ where: { householdId: c.householdId, memberId: null }, include: { deviceReads: { where: { deviceId: c.actor.deviceId } } }, orderBy: { createdAt: 'desc' }, take: 100 });
      return rows.map(({ deviceReads, ...r }) => ({ ...r, readAt: deviceReads[0]?.readAt ?? null }));
    }
    return prisma.notification.findMany({ where: { householdId: c.householdId, memberId: c.actor.memberId }, orderBy: { createdAt: 'desc' }, take: 50 });
  });

  route(m, { method: 'post', path: '/notifications/read', summary: 'Mark notifications as read', tags: ['Notifications'], body: z.object({ ids: z.array(z.string().uuid()).max(100).optional() }) }, async (req, _res, { body }) => {
    const c = ctx(req);
    if (c.actor.kind === 'device') {
      const deviceId = c.actor.deviceId;
      const rows = await prisma.notification.findMany({ where: { householdId: c.householdId, memberId: null, ...(body.ids ? { id: { in: body.ids } } : {}), deviceReads: { none: { deviceId } } }, select: { id: true } });
      const r = await prisma.deviceNotificationRead.createMany({ data: rows.map((n) => ({ deviceId, notificationId: n.id })), skipDuplicates: true });
      return { updated: r.count };
    }
    const r = await prisma.notification.updateMany({
      where: { householdId: c.householdId, memberId: c.actor.memberId, readAt: null, ...(body.ids ? { id: { in: body.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { updated: r.count };
  });

  return router;
}
