import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { acceptInvitationSchema, approveJoinSchema, can, verifyCodeSchema } from '@familyhub/shared';
import type { JoinRequest } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { emailAdapter } from '../lib/email.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { issueCode, consumeCode } from '../lib/otp.js';
import { realtime } from '../lib/realtime.js';
import { route, type Mount } from '../lib/route.js';
import { requireUser } from '../auth/session.js';
import { ctx, householdContext } from '../auth/context.js';
import { MEMBER_COLORS } from '../services/households.js';

const codeLimiter = rateLimit({
  windowMs: 15 * 60000,
  limit: config.NODE_ENV === 'test' ? 1000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
});

type WithUser = JoinRequest & { user: { email: string; displayName: string }; household?: { name: string } };

function status(j: JoinRequest) {
  if (j.completedAt) return 'approved' as const;
  if (j.rejectedAt) return 'rejected' as const;
  if (j.expiresAt < new Date()) return 'expired' as const;
  return 'pending' as const;
}

export function joinRequestDTO(j: WithUser) {
  return {
    id: j.id,
    householdId: j.householdId,
    householdName: j.household?.name ?? null,
    email: j.user.email,
    displayName: j.user.displayName,
    role: j.role,
    requesterVerified: Boolean(j.requesterVerifiedAt),
    approved: Boolean(j.approvedAt),
    status: status(j),
    createdAt: j.createdAt,
    expiresAt: j.expiresAt,
  };
}

export const activeJoinWhere = () => ({ completedAt: null, rejectedAt: null, expiresAt: { gt: new Date() } });

async function adminsOf(householdId: string) {
  const members = await prisma.householdMember.findMany({
    where: { householdId, isActive: true, userId: { not: null } },
    include: { user: { select: { id: true, email: true } } },
  });
  return members.filter((m) => m.user && can({ kind: 'member', memberId: m.id, userId: m.user.id, role: m.role }, 'members.manage'));
}

async function sendAdminCodes(j: WithUser, householdName: string, only?: string) {
  const admins = (await adminsOf(j.householdId)).filter((a) => !only || a.user!.id === only);
  await Promise.all(
    admins.map((a) =>
      issueCode({
        userId: a.user!.id,
        email: a.user!.email,
        purpose: 'join_admin',
        subjectId: j.id,
        subject: `Approve ${j.user.displayName} joining ${householdName}`,
        intro: `${j.user.displayName} (${j.user.email}) asked to join "${householdName}" on FamilyHub.\nTo approve, open FamilyHub → Family → Join requests and enter this code. You can also tap Approve on your home display.`,
        enforceCooldown: Boolean(only),
      }),
    ),
  );
  return admins;
}

async function sendRequesterCode(j: WithUser, householdName: string, enforceCooldown = false) {
  return issueCode({
    userId: j.userId,
    email: j.user.email,
    purpose: 'join_requester',
    subjectId: j.id,
    subject: `Your code to join ${householdName}`,
    intro: `You asked to join "${householdName}" on FamilyHub. Enter this code in the app to confirm it's you.`,
    enforceCooldown,
  });
}

/** Adds the requester to the household once both sides have confirmed. */
async function completeIfReady(id: string) {
  const original = await prisma.joinRequest.findUniqueOrThrow({ where: { id }, select: { householdId: true } });
  const { done, memberId } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM households WHERE id = ${original.householdId}::uuid FOR UPDATE`;
    const j = await tx.joinRequest.findUniqueOrThrow({ where: { id }, include: { user: true, invitation: true, household: { select: { name: true } } } });
    if (j.rejectedAt || j.invitation.revokedAt || j.expiresAt < new Date()) throw notFound('Join request');
    if (!j.requesterVerifiedAt || !j.approvedAt || j.completedAt) return { done: j, memberId: null };
    const existing = await tx.householdMember.findFirst({ where: { householdId: j.householdId, userId: j.userId } });
    let member;
    if (existing) member = existing.isActive && (!existing.accessExpiresAt || existing.accessExpiresAt > new Date()) ? existing : await tx.householdMember.update({ where: { id: existing.id }, data: { isActive: true, role: j.role, accessExpiresAt: null } });
    if (!member && j.invitation.memberId) {
      const target = await tx.householdMember.findFirst({ where: { id: j.invitation.memberId, householdId: j.householdId } });
      if (target && !target.userId) member = await tx.householdMember.update({ where: { id: target.id }, data: { userId: j.userId, role: j.role, isActive: true } });
    }
    if (!member) {
      const count = await tx.householdMember.count({ where: { householdId: j.householdId } });
      member = await tx.householdMember.create({
        data: { householdId: j.householdId, userId: j.userId, firstName: j.user.displayName.split(' ')[0] ?? j.user.displayName, displayName: j.user.displayName, role: j.role, color: MEMBER_COLORS[count % MEMBER_COLORS.length]! },
      });
    }
    const completed = await tx.joinRequest.update({ where: { id }, data: { completedAt: new Date(), memberId: member.id }, include: { user: true, household: { select: { name: true } } } });
    return { done: completed, memberId: member.id };
  });
  if (!memberId) return done;
  realtime.publish(done.householdId, { type: 'members.changed' });
  realtime.publish(done.householdId, { type: 'join.changed', entityId: id });
  void emailAdapter.send({ to: done.user.email, subject: `You're in: ${done.household.name}`, text: `Your request to join "${done.household.name}" on FamilyHub was approved. Open ${config.WEB_ORIGIN} to get started.` });
  void notify(done.householdId, { type: 'member.joined', title: `${done.user.displayName} joined the family`, url: '/family' }, { except: memberId });
  return done;
}

/** Routes for the person asking to join. */
export function joinUserRouter() {
  const router = Router();
  const m: Mount = { router, prefix: '/api/v1' };
  const tags = ['Invitations'];

  route(m, { method: 'get', path: '/me/invitations', summary: 'Pending home invitations addressed to my account', tags, middleware: [requireUser] }, async (req) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId! } });
    const invitations = await prisma.invitation.findMany({
      where: { email: user.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { household: { select: { name: true } }, invitedBy: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return invitations.map((i) => ({ id: i.id, householdId: i.householdId, householdName: i.household.name, invitedBy: i.invitedBy.displayName, role: i.role, expiresAt: i.expiresAt }));
  });

  route(
    m,
    { method: 'post', path: '/invitations/accept', summary: 'Ask to join a household with an invitation (needs both-side approval)', tags, body: acceptInvitationSchema.or(z.object({ invitationId: z.string().uuid() })), status: 201, middleware: [requireUser, codeLimiter] },
    async (req, _res, { body }) => {
      const inv = await prisma.invitation.findUnique({ where: 'token' in body ? { tokenHash: sha256(body.token) } : { id: body.invitationId }, include: { household: { select: { name: true } }, joinRequest: { include: { user: true } } } });
      if (!inv || inv.revokedAt || inv.expiresAt < new Date()) throw notFound('Invitation');
      const userId = req.auth!.userId!;
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.email !== inv.email) throw new AppError(403, 'EMAIL_MISMATCH', 'Sign in with the email address this invitation was sent to');
      const already = await prisma.householdMember.findFirst({ where: { householdId: inv.householdId, userId, isActive: true, OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: new Date() } }] } });
      if (already) return { householdId: inv.householdId, householdName: inv.household.name, alreadyMember: true };
      if (inv.joinRequest) {
        if (inv.joinRequest.userId !== userId) throw notFound('Invitation');
        return { joinRequest: joinRequestDTO({ ...inv.joinRequest, household: inv.household }) };
      }
      if (inv.acceptedAt) throw notFound('Invitation');
      const [, j] = await prisma.$transaction([
        prisma.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
        prisma.joinRequest.create({ data: { householdId: inv.householdId, invitationId: inv.id, userId, role: inv.role, expiresAt: new Date(Date.now() + 7 * 86400000) }, include: { user: true } }),
      ]);
      await sendRequesterCode(j, inv.household.name);
      const admins = await sendAdminCodes(j, inv.household.name);
      void notify(inv.householdId, { type: 'join.requested', title: `${user.displayName} wants to join`, body: 'Approve in Family → Join requests with the code we emailed you, or on the home display.', url: '/family' }, { to: admins.map((a) => a.id) });
      realtime.publish(inv.householdId, { type: 'join.changed', entityId: j.id });
      await audit(req, { householdId: inv.householdId, action: 'join.requested', entityType: 'join_request', entityId: j.id });
      return { joinRequest: joinRequestDTO({ ...j, household: inv.household }) };
    },
  );

  route(m, { method: 'get', path: '/join-requests/mine', summary: 'My join requests (last 7 days)', tags, middleware: [requireUser] }, async (req) => {
    const list = await prisma.joinRequest.findMany({
      where: { userId: req.auth!.userId!, createdAt: { gt: new Date(Date.now() - 7 * 86400000) } },
      include: { user: true, household: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return list.map(joinRequestDTO);
  });

  const mine = async (req: Request) => {
    const j = await prisma.joinRequest.findFirst({ where: { id: String(req.params.id), userId: req.auth!.userId!, ...activeJoinWhere() }, include: { user: true, household: { select: { name: true } } } });
    if (!j) throw notFound('Join request');
    return j;
  };

  route(
    m,
    { method: 'post', path: '/join-requests/:id/verify', summary: 'Confirm my join request with the emailed code', tags, body: verifyCodeSchema, middleware: [requireUser, codeLimiter] },
    async (req, _res, { body }) => {
      const j = await mine(req);
      if (!j.requesterVerifiedAt) {
        await consumeCode({ userId: j.userId, purpose: 'join_requester', subjectId: j.id, code: body.code });
        await prisma.joinRequest.update({ where: { id: j.id }, data: { requesterVerifiedAt: new Date() } });
        realtime.publish(j.householdId, { type: 'join.changed', entityId: j.id });
      }
      const done = await completeIfReady(j.id);
      return joinRequestDTO(done);
    },
  );

  route(m, { method: 'post', path: '/join-requests/:id/resend', summary: 'Email me a new join code', tags, middleware: [requireUser, codeLimiter] }, async (req) => {
    const j = await mine(req);
    if (j.requesterVerifiedAt) return { emailSent: false };
    return { emailSent: await sendRequesterCode(j, j.household.name, true) };
  });

  return router;
}

/** Household-side review: admins (with their emailed code) or a paired home device. */
export function joinHouseholdRouter() {
  const router = Router({ mergeParams: true });
  router.use(householdContext);
  const m: Mount = { router, prefix: '/api/v1/households/:householdId' };
  const tags = ['Invitations'];

  const reviewer = (req: Request) => {
    const a = ctx(req).actor;
    if (a.kind === 'device') return { kind: 'device' as const, id: a.deviceId };
    if (can(a, 'members.manage')) return { kind: 'member' as const, id: a.memberId, userId: a.userId };
    throw forbidden('Only parents/admins or the home display can review join requests');
  };
  const pending = async (req: Request) => {
    const j = await prisma.joinRequest.findFirst({ where: { id: String(req.params.id), householdId: ctx(req).householdId, ...activeJoinWhere() }, include: { user: true, household: { select: { name: true } } } });
    if (!j) throw notFound('Join request');
    return j;
  };

  route(m, { method: 'get', path: '/join-requests', summary: 'Pending join requests', tags }, async (req) => {
    reviewer(req);
    const list = await prisma.joinRequest.findMany({ where: { householdId: ctx(req).householdId, ...activeJoinWhere() }, include: { user: true }, orderBy: { createdAt: 'desc' } });
    return list.map(joinRequestDTO);
  });

  route(
    m,
    { method: 'post', path: '/join-requests/:id/approve', summary: 'Approve a join request (admins need their emailed code; home devices do not)', tags, body: approveJoinSchema, middleware: [codeLimiter] },
    async (req, _res, { body }) => {
      const who = reviewer(req);
      const j = await pending(req);
      if (who.kind === 'member') {
        if (!body.code) throw new AppError(400, 'CODE_REQUIRED', 'Enter the code we emailed you');
        await consumeCode({ userId: who.userId, purpose: 'join_admin', subjectId: j.id, code: body.code });
      }
      if (!j.approvedAt) {
        await prisma.joinRequest.update({ where: { id: j.id }, data: { approvedAt: new Date(), approvedBy: `${who.kind}:${who.id}` } });
      }
      realtime.publish(j.householdId, { type: 'join.changed', entityId: j.id });
      await audit(req, { householdId: j.householdId, action: 'join.approved', entityType: 'join_request', entityId: j.id, metadata: { via: who.kind } });
      return joinRequestDTO(await completeIfReady(j.id));
    },
  );

  route(m, { method: 'post', path: '/join-requests/:id/reject', summary: 'Decline a join request', tags }, async (req) => {
    const who = reviewer(req);
    const j = await pending(req);
    const done = await prisma.joinRequest.update({ where: { id: j.id }, data: { rejectedAt: new Date() }, include: { user: true } });
    realtime.publish(j.householdId, { type: 'join.changed', entityId: j.id });
    await audit(req, { householdId: j.householdId, action: 'join.rejected', entityType: 'join_request', entityId: j.id, metadata: { via: who.kind } });
    return joinRequestDTO(done);
  });

  route(m, { method: 'post', path: '/join-requests/:id/resend', summary: 'Email me a new approval code', tags, middleware: [codeLimiter] }, async (req) => {
    const who = reviewer(req);
    if (who.kind !== 'member') return { emailSent: false };
    const j = await pending(req);
    const sent = await sendAdminCodes(j, j.household.name, who.userId);
    return { emailSent: sent.length > 0 };
  });

  return router;
}
