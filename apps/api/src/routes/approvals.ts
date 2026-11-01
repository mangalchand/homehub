import { Router, type Response } from 'express';
import { prisma } from '../db.js';
import { sha256 } from '../lib/crypto.js';
import { requestApproval, tellDecision } from '../lib/approvals.js';
import { AppError } from '../lib/errors.js';
import { emailNotVerified, requireSignedInUser } from '../auth/session.js';

const RESEND_COOLDOWN_MS = 10 * 60_000;
const lastResend = new Map<string, number>();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const STYLE = 'body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f4fb;color:#1e1b4b;display:flex;justify-content:center;padding:40px 16px;margin:0}main{background:#fff;border-radius:22px;box-shadow:0 12px 32px rgba(30,27,75,.08);padding:28px;max-width:460px;width:100%}h1{font-size:22px;margin:0 0 14px}p{line-height:1.55;overflow-wrap:anywhere}form{display:inline}button{font:inherit;font-weight:600;border:0;border-radius:12px;padding:12px 22px;margin:14px 10px 0 0;cursor:pointer}.ok{background:#4f46e5;color:#fff}.no{background:#fee2e2;color:#991b1b}';
const send = (res: Response, status: number, title: string, body: string) =>
  res
    .status(status)
    .set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    .type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
const invalid = (res: Response) => send(res, 404, 'Link not valid', '<p>This approval link was already used or is not valid.</p>');

async function findTarget(token: string) {
  const hash = sha256(token);
  const user = await prisma.user.findUnique({ where: { approvalTokenHash: hash } });
  if (user) return { kind: 'user' as const, hash, id: user.id, label: `account <b>${esc(user.displayName)}</b> (${esc(user.email)})`, createdAt: user.createdAt, notify: [user.email] };
  const household = await prisma.household.findUnique({ where: { approvalTokenHash: hash } });
  if (!household) return null;
  const owners = await prisma.householdMember.findMany({ where: { householdId: household.id, role: 'OWNER', userId: { not: null } }, select: { userId: true } });
  const users = await prisma.user.findMany({ where: { id: { in: owners.map((o) => o.userId!) } }, select: { email: true, displayName: true } });
  const by = users.map((u) => `${esc(u.displayName)} (${esc(u.email)})`).join(', ');
  return { kind: 'household' as const, hash, id: household.id, label: `home <b>${esc(household.name)}</b>${by ? ' created by ' + by : ''}`, createdAt: household.createdAt, notify: users.map((u) => u.email) };
}

/** One-time owner approval links sent by email for new accounts and homes. */
export function approvalsRouter() {
  const router = Router();
  router.get('/approvals/:token', async (req, res, next) => {
    try {
      const t = await findTarget(req.params.token);
      if (!t) return invalid(res);
      const action = '/api/v1/approvals/' + encodeURIComponent(req.params.token);
      send(res, 200, 'Approve FamilyHub request', `<p>New ${t.label}.</p><p>Requested ${esc(t.createdAt.toUTCString())}.</p><form method="post" action="${action}/approve"><button class="ok">Approve</button></form><form method="post" action="${action}/reject"><button class="no">Reject</button></form>`);
    } catch (e) {
      next(e);
    }
  });
  router.post('/approvals/:token/:decision', async (req, res, next) => {
    try {
      const decision = req.params.decision;
      if (decision !== 'approve' && decision !== 'reject') return invalid(res);
      const t = await findTarget(req.params.token);
      if (!t) return invalid(res);
      const data = { approvalStatus: decision === 'approve' ? 'APPROVED' : 'REJECTED', approvalTokenHash: null };
      const where = { id: t.id, approvalTokenHash: t.hash };
      const done = t.kind === 'user' ? await prisma.user.updateMany({ where, data }) : await prisma.household.updateMany({ where, data });
      if (done.count !== 1) return invalid(res);
      if (t.kind === 'user' && decision === 'reject') await prisma.session.deleteMany({ where: { userId: t.id } });
      await Promise.all(t.notify.map((to) => tellDecision(to, t.kind === 'user' ? 'account' : 'home', decision === 'approve')));
      send(res, 200, decision === 'approve' ? 'Approved' : 'Rejected', `<p>The ${t.label} was ${decision === 'approve' ? 'approved' : 'rejected'}. We emailed them.</p>`);
    } catch (e) {
      next(e);
    }
  });
  router.post('/approval-requests/resend', requireSignedInUser, async (req, res, next) => {
    try {
      const userId = req.auth!.userId!;
      if (!req.auth!.emailVerified) throw emailNotVerified();
      if (Date.now() - (lastResend.get(userId) ?? 0) < RESEND_COOLDOWN_MS) throw new AppError(429, 'RATE_LIMITED', 'Your request was sent a few minutes ago. Please wait before sending it again.');
      lastResend.set(userId, Date.now());
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const homes = await prisma.household.findMany({ where: { approvalStatus: 'PENDING', members: { some: { userId, role: 'OWNER' } } } });
      const sent = await Promise.all([
        ...(user.approvalStatus === 'PENDING' ? [requestApproval('user', user.id, 'PENDING', `New account: ${user.displayName} <${user.email}>`)] : []),
        ...homes.map((h) => requestApproval('household', h.id, 'PENDING', `New home "${h.name}" (${h.timezone}) created by ${user.displayName} <${user.email}>`)),
      ]);
      res.json({ requested: sent.length, sent: sent.filter(Boolean).length });
    } catch (e) {
      next(e);
    }
  });
  return router;
}
