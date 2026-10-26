import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  assignableRoles,
  DEVICE_ASSIGNABLE_ROLES,
  createDeviceSchema,
  createHouseholdSchema,
  createInvitationSchema,
  createMemberSchema,
  setPinSchema,
  updateHouseholdSchema,
  updateMemberSchema,
  verifyPinSchema,
  type MemberRole,
} from '@familyhub/shared';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { pairingCode, randomToken, sha256 } from '../lib/crypto.js';
import { emailAdapter } from '../lib/email.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';
import { memberDTO } from '../lib/serialize.js';
import { hashSecret, verifySecret } from '../auth/passwords.js';
import { requireUser } from '../auth/session.js';
import { ctx, householdContext, requireCap } from '../auth/context.js';
import { createHouseholdWithDefaults, exportHousehold, MEMBER_COLORS } from '../services/households.js';

const pinLimiter = rateLimit({
  windowMs: 5 * 60000,
  limit: config.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: (req) => req.auth?.sessionId ?? req.ip ?? 'anon',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many PIN attempts. Wait a few minutes.' } },
});

function householdDTO(h: { id: string; name: string; timezone: string; locale: string; weekStartsOn: number; settings: unknown; pinHash: string | null }) {
  return { id: h.id, name: h.name, timezone: h.timezone, locale: h.locale, weekStartsOn: h.weekStartsOn, settings: h.settings, hasPin: Boolean(h.pinHash) };
}

/** Routes not scoped to an existing household. */
export function householdRootRouter() {
  const router = Router();
  const m: Mount = { router, prefix: '/api/v1' };
  route(
    m,
    { method: 'post', path: '/households', summary: 'Create a household (caller becomes owner)', tags: ['Households'], body: createHouseholdSchema, status: 201, middleware: [requireUser] },
    async (req, _res, { body }) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId! } });
      const { household, owner } = await createHouseholdWithDefaults({
        userId: user.id,
        name: body.name,
        timezone: body.timezone,
        ownerFirstName: body.ownerFirstName ?? user.displayName.split(' ')[0] ?? user.displayName,
        ownerColor: body.ownerColor,
      });
      await audit(req, { householdId: household.id, action: 'household.created', entityType: 'household', entityId: household.id });
      return { household: householdDTO(household), memberId: owner.id };
    },
  );
  return router;
}

/** Routes under /households/:householdId */
export function householdRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };

  route(m, { method: 'get', path: '/', summary: 'Get household', tags: ['Households'] }, (req) => householdDTO(ctx(req).household));

  route(
    m,
    { method: 'patch', path: '/', summary: 'Update household settings', tags: ['Households'], body: updateHouseholdSchema, middleware: [requireCap('household.manage')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const settings = body.settings ? { ...(c.household.settings as object), ...body.settings } : undefined;
      const updated = await prisma.household.update({
        where: { id: c.householdId },
        data: { name: body.name, timezone: body.timezone, locale: body.locale, weekStartsOn: body.weekStartsOn, settings },
      });
      await audit(req, { householdId: c.householdId, action: 'household.updated', entityType: 'household', entityId: c.householdId });
      realtime.publish(c.householdId, { type: 'household.changed' });
      return householdDTO(updated);
    },
  );

  route(
    m,
    {
      method: 'delete', path: '/', summary: 'Permanently delete the household and all of its data', tags: ['Households'],
      body: z.object({ confirmName: z.string() }), middleware: [requireUser, requireCap('household.manage')],
    },
    async (req, _res, { body }) => {
      const c = ctx(req);
      if (body.confirmName !== c.household.name) throw badRequest('Type the household name exactly to confirm deletion');
      await audit(req, { householdId: null, action: 'household.deleted', entityType: 'household', entityId: c.householdId, metadata: { name: c.household.name } });
      await prisma.household.delete({ where: { id: c.householdId } });
      return undefined;
    },
  );

  route(
    m,
    { method: 'get', path: '/export', summary: 'Export all household data as JSON', tags: ['Households'], middleware: [requireUser, requireCap('household.manage')], raw: true },
    async (req, res) => {
      const c = ctx(req);
      const data = await exportHousehold(c.householdId);
      await audit(req, { householdId: c.householdId, action: 'household.exported', entityType: 'household', entityId: c.householdId });
      res.setHeader('Content-Disposition', `attachment; filename="familyhub-export-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(data);
    },
  );

  // ── PIN ──
  route(
    m,
    { method: 'put', path: '/pin', summary: 'Set or change the household PIN', tags: ['Security'], body: setPinSchema, middleware: [requireUser, requireCap('household.manage')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      await prisma.household.update({ where: { id: c.householdId }, data: { pinHash: await hashSecret(body.pin) } });
      await audit(req, { householdId: c.householdId, action: 'household.pin_set', entityType: 'household', entityId: c.householdId });
      return { ok: true };
    },
  );

  route(
    m,
    { method: 'post', path: '/pin/verify', summary: 'Verify the household PIN to unlock privileged actions for 5 minutes', tags: ['Security'], body: verifyPinSchema, middleware: [pinLimiter] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      if (!c.household.pinHash) throw new AppError(422, 'PIN_NOT_SET', 'No household PIN has been set');
      const ok = await verifySecret(c.household.pinHash, body.pin);
      if (!ok) {
        await audit(req, { householdId: c.householdId, action: 'household.pin_failed', entityType: 'session', entityId: req.auth!.sessionId });
        throw new AppError(401, 'INVALID_PIN', 'Incorrect PIN');
      }
      const until = new Date(Date.now() + 5 * 60000);
      await prisma.session.update({ where: { id: req.auth!.sessionId }, data: { pinElevatedUntil: until } });
      return { elevatedUntil: until.toISOString() };
    },
  );

  route(m, { method: 'post', path: '/pin/lock', summary: 'End PIN elevation now', tags: ['Security'] }, async (req) => {
    await prisma.session.update({ where: { id: req.auth!.sessionId }, data: { pinElevatedUntil: null } });
    return undefined;
  });

  // ── Members ──
  route(m, { method: 'get', path: '/members', summary: 'List family members', tags: ['Members'] }, async (req) => {
    const c = ctx(req);
    const members = await prisma.householdMember.findMany({
      where: { householdId: c.householdId, ...(c.actor.kind === 'device' ? { isActive: true } : {}) },
      orderBy: [{ createdAt: 'asc' }],
    });
    return members.map((mm) => memberDTO(mm, c.actor));
  });

  route(m, { method: 'get', path: '/members/:memberId', summary: 'Get one family member profile', tags: ['Members'] }, async (req) => {
    const c = ctx(req);
    const member = await prisma.householdMember.findFirst({ where: { id: req.params.memberId, householdId: c.householdId } });
    if (!member) throw notFound('Member');
    return memberDTO(member, c.actor);
  });

  async function householdOwnerUserId(householdId: string) {
    const owner = await prisma.householdMember.findFirst({ where: { householdId, role: 'OWNER', userId: { not: null } }, orderBy: { createdAt: 'asc' } });
    if (!owner?.userId) throw forbidden('This household has no owner account to send invitations from');
    return owner.userId;
  }

  function assertAssignable(req: Parameters<typeof ctx>[0], role: MemberRole) {
    const a = ctx(req).actor;
    const allowed = a.kind === 'member' ? assignableRoles(a.role) : a.elevated ? DEVICE_ASSIGNABLE_ROLES : [];
    if (!allowed.includes(role)) throw forbidden(`You cannot assign the ${role} role`);
  }

  route(
    m,
    { method: 'post', path: '/members', summary: 'Add a family member profile (no login required)', tags: ['Members'], body: createMemberSchema, status: 201, middleware: [requireCap('members.manage')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      assertAssignable(req, body.role);
      const count = await prisma.householdMember.count({ where: { householdId: c.householdId } });
      const member = await prisma.householdMember.create({
        data: {
          householdId: c.householdId,
          firstName: body.firstName,
          displayName: body.displayName ?? body.firstName,
          role: body.role,
          color: body.color ?? MEMBER_COLORS[count % MEMBER_COLORS.length]!,
          birthDate: body.birthDate ? new Date(body.birthDate) : null,
          avatarUrl: body.avatarUrl ?? null,
          accessExpiresAt: body.accessExpiresAt ? new Date(body.accessExpiresAt) : null,
          emergencyContact: body.emergencyContact ?? undefined,
        },
      });
      await audit(req, { householdId: c.householdId, action: 'member.created', entityType: 'member', entityId: member.id, metadata: { role: member.role } });
      realtime.publish(c.householdId, { type: 'members.changed' });
      return memberDTO(member, c.actor);
    },
  );

  route(
    m,
    { method: 'patch', path: '/members/:memberId', summary: 'Update a family member', tags: ['Members'], body: updateMemberSchema },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const target = await prisma.householdMember.findFirst({ where: { id: req.params.memberId, householdId: c.householdId } });
      if (!target) throw notFound('Member');
      const isSelf = c.actor.kind === 'member' && c.actor.memberId === target.id;
      const canManage = c.actor.kind === 'member' ? ['OWNER', 'ADULT_ADMIN'].includes(c.actor.role) : c.actor.elevated;
      if (!canManage && !isSelf) throw forbidden();
      if (!canManage && (body.role || body.isActive !== undefined || body.accessExpiresAt !== undefined)) {
        throw forbidden('Only household admins can change roles or access');
      }
      if (body.role && body.role !== target.role) {
        assertAssignable(req, body.role);
        if (target.role === 'OWNER') {
          const owners = await prisma.householdMember.count({ where: { householdId: c.householdId, role: 'OWNER', isActive: true } });
          if (owners <= 1) throw conflict('A household must keep at least one owner');
        }
      }
      if (target.role === 'OWNER' && c.actor.kind === 'member' && c.actor.role !== 'OWNER') throw forbidden('Only owners can edit owners');
      const updated = await prisma.householdMember.update({
        where: { id: target.id },
        data: {
          firstName: body.firstName,
          displayName: body.displayName,
          role: body.role,
          color: body.color,
          birthDate: body.birthDate === undefined ? undefined : body.birthDate ? new Date(body.birthDate) : null,
          avatarUrl: body.avatarUrl,
          accessExpiresAt: body.accessExpiresAt === undefined ? undefined : body.accessExpiresAt ? new Date(body.accessExpiresAt) : null,
          emergencyContact: body.emergencyContact === null ? undefined : body.emergencyContact,
          preferences: body.preferences as object | undefined,
          isActive: body.isActive,
        },
      });
      await audit(req, { householdId: c.householdId, action: 'member.updated', entityType: 'member', entityId: target.id, metadata: { fields: Object.keys(body) } });
      realtime.publish(c.householdId, { type: 'members.changed' });
      return memberDTO(updated, c.actor);
    },
  );

  route(
    m,
    { method: 'delete', path: '/members/:memberId', summary: 'Remove a family member', tags: ['Members'], middleware: [requireCap('members.manage')] },
    async (req) => {
      const c = ctx(req);
      const target = await prisma.householdMember.findFirst({ where: { id: req.params.memberId, householdId: c.householdId } });
      if (!target) throw notFound('Member');
      if (target.role === 'OWNER') throw conflict('Transfer ownership before removing an owner');
      assertAssignable(req, target.role);
      await prisma.$transaction([
        prisma.session.updateMany({ where: { userId: target.userId ?? '00000000-0000-0000-0000-000000000000', revokedAt: null, householdId: null }, data: {} }),
        prisma.householdMember.delete({ where: { id: target.id } }),
      ]);
      await audit(req, { householdId: c.householdId, action: 'member.removed', entityType: 'member', entityId: target.id });
      realtime.publish(c.householdId, { type: 'members.changed' });
      return undefined;
    },
  );

  // ── Invitations ──
  route(m, { method: 'get', path: '/invitations', summary: 'List pending invitations', tags: ['Invitations'], middleware: [requireCap('members.manage')] }, async (req) => {
    const c = ctx(req);
    const invs = await prisma.invitation.findMany({
      where: { householdId: c.householdId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return invs.map((i) => ({ id: i.id, email: i.email, role: i.role, memberId: i.memberId, expiresAt: i.expiresAt, createdAt: i.createdAt }));
  });

  route(
    m,
    { method: 'post', path: '/invitations', summary: 'Invite someone by email', tags: ['Invitations'], body: createInvitationSchema, status: 201, middleware: [requireCap('members.manage')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      assertAssignable(req, body.role);
      if (body.memberId) {
        const target = await prisma.householdMember.findFirst({ where: { id: body.memberId, householdId: c.householdId } });
        if (!target) throw notFound('Member');
        if (target.userId) throw conflict('This profile already has a login');
      }
      const token = randomToken(32);
      const inv = await prisma.invitation.create({
        data: {
          householdId: c.householdId,
          email: body.email,
          role: body.role,
          memberId: body.memberId ?? null,
          tokenHash: sha256(token),
          invitedById: req.auth!.userId ?? (await householdOwnerUserId(c.householdId)),
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
      });
      const acceptUrl = `${config.WEB_ORIGIN}/invite/${token}`;
      const emailSent = await emailAdapter.send({
        to: body.email,
        subject: `You're invited to ${c.household.name} on FamilyHub`,
        text: `Join ${c.household.name}: ${acceptUrl} (expires in 7 days)`,
      });
      await audit(req, { householdId: c.householdId, action: 'invitation.created', entityType: 'invitation', entityId: inv.id, metadata: { email: body.email, role: body.role } });
      // The link is also returned so admins can share it directly (e.g. WhatsApp) if email is off or fails.
      return { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, acceptUrl, emailSent };
    },
  );

  route(m, { method: 'delete', path: '/invitations/:invitationId', summary: 'Revoke an invitation', tags: ['Invitations'], middleware: [requireCap('members.manage')] }, async (req) => {
    const c = ctx(req);
    const r = await prisma.invitation.updateMany({
      where: { id: req.params.invitationId, householdId: c.householdId, acceptedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!r.count) throw notFound('Invitation');
    await audit(req, { householdId: c.householdId, action: 'invitation.revoked', entityType: 'invitation', entityId: req.params.invitationId });
    return undefined;
  });

  // ── Devices ──
  route(m, { method: 'get', path: '/devices', summary: 'List wall displays', tags: ['Devices'], middleware: [requireCap('devices.manage')] }, async (req) => {
    const devices = await prisma.device.findMany({ where: { householdId: ctx(req).householdId }, orderBy: { createdAt: 'desc' } });
    return devices.map((d) => ({
      id: d.id, name: d.name, type: d.type, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt,
      pairingPending: Boolean(d.pairingExpiresAt && d.pairingExpiresAt > new Date()),
    }));
  });

  route(
    m,
    { method: 'post', path: '/devices', summary: 'Register a wall display and get a one-time pairing code', tags: ['Devices'], body: createDeviceSchema, status: 201, middleware: [requireUser, requireCap('devices.manage')] },
    async (req, _res, { body }) => {
      const c = ctx(req);
      const code = pairingCode(8);
      const device = await prisma.device.create({
        data: { householdId: c.householdId, name: body.name, pairingCodeHash: sha256(code), pairingExpiresAt: new Date(Date.now() + 15 * 60000) },
      });
      await audit(req, { householdId: c.householdId, action: 'device.created', entityType: 'device', entityId: device.id });
      return { id: device.id, name: device.name, pairingCode: code, pairingExpiresAt: device.pairingExpiresAt };
    },
  );

  route(m, { method: 'delete', path: '/devices/:deviceId', summary: 'Revoke a wall display and sign it out', tags: ['Devices'], middleware: [requireCap('devices.manage')] }, async (req) => {
    const c = ctx(req);
    const device = await prisma.device.findFirst({ where: { id: req.params.deviceId, householdId: c.householdId } });
    if (!device) throw notFound('Device');
    await prisma.$transaction([
      prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date(), pairingCodeHash: null } }),
      prisma.session.updateMany({ where: { deviceId: device.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit(req, { householdId: c.householdId, action: 'device.revoked', entityType: 'device', entityId: device.id });
    return undefined;
  });

  // ── Audit log ──
  route(
    m,
    {
      method: 'get', path: '/audit-logs', summary: 'Household audit log (cursor paginated)', tags: ['Security'],
      query: z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      middleware: [requireCap('audit.read')],
    },
    async (req, _res, { query }) => {
      const rows = await prisma.auditLog.findMany({
        where: { householdId: ctx(req).householdId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        include: { actorUser: { select: { displayName: true } } },
      });
      const items = rows.slice(0, query.limit);
      return {
        items: items.map((r) => ({
          id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId, metadata: r.metadata,
          actor: r.actorUser?.displayName ?? (r.actorDeviceId ? 'Wall display' : null), createdAt: r.createdAt,
        })),
        nextCursor: rows.length > query.limit ? items[items.length - 1]!.id : null,
      };
    },
  );

  return router;
}
