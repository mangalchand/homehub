import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  devicePairSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
  userPreferencesSchema,
  verifyCodeSchema,
} from '@familyhub/shared';
import { config, providerConfigured } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, pkcePair, randomToken, sha256 } from '../lib/crypto.js';
import { emailAdapter } from '../lib/email.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { route, type Mount } from '../lib/route.js';
import { hashSecret, verifySecret } from '../auth/passwords.js';
import { CSRF_COOKIE, clearSessionCookie, requireAuth, requireSignedInUser, requireUser, startSession } from '../auth/session.js';
import { issueCode, consumeCode } from '../lib/otp.js';
import { activeJoinWhere, joinRequestDTO } from './join.js';

const authLimiter = rateLimit({
  windowMs: 15 * 60000,
  limit: config.NODE_ENV === 'test' ? 1000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
});

const sendVerifyCode = (user: { id: string; email: string; displayName: string }, enforceCooldown = false) =>
  issueCode({
    userId: user.id,
    email: user.email,
    purpose: 'verify_email',
    subject: 'Confirm your FamilyHub email',
    intro: `Hi ${user.displayName}, welcome to FamilyHub! Enter this code to finish creating your account.`,
    enforceCooldown,
  });

export function authRouter() {
  const router = Router();
  const m: Mount = { router, prefix: '/api/v1' };
  const tags = ['Auth'];

  route(m, { method: 'get', path: '/auth/csrf', summary: 'Get CSRF token (double-submit cookie)', tags, auth: false }, (req) => ({
    csrfToken: req.cookies[CSRF_COOKIE],
  }));

  route(m, { method: 'get', path: '/auth/providers', summary: 'Which sign-in providers are configured', tags, auth: false }, () => ({
    password: true,
    google: providerConfigured.google(),
  }));

  route(
    m,
    { method: 'post', path: '/auth/register', summary: 'Create an account', tags, body: registerSchema, status: 201, auth: false, middleware: [authLimiter] },
    async (req, res, { body }) => {
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) throw conflict('An account with this email already exists');
      const user = await prisma.user.create({
        data: { email: body.email, displayName: body.displayName, passwordHash: await hashSecret(body.password) },
      });
      await startSession(req, res, { userId: user.id });
      await audit(req, { action: 'auth.register', entityType: 'user', entityId: user.id });
      const emailSent = await sendVerifyCode(user);
      return { user: { id: user.id, email: user.email, displayName: user.displayName, emailVerified: false }, emailSent };
    },
  );

  route(
    m,
    { method: 'post', path: '/auth/login', summary: 'Sign in with email and password', tags, body: loginSchema, auth: false, middleware: [authLimiter] },
    async (req, res, { body }) => {
      const user = await prisma.user.findUnique({ where: { email: body.email } });
      const ok = await verifySecret(user?.passwordHash, body.password);
      if (!user || !ok) {
        await audit(req, { action: 'auth.login_failed', entityType: 'user', entityId: user?.id ?? null, metadata: { email: body.email } });
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      }
      await startSession(req, res, { userId: user.id });
      await audit(req, { action: 'auth.login', entityType: 'user', entityId: user.id });
      return { user: { id: user.id, email: user.email, displayName: user.displayName, emailVerified: Boolean(user.emailVerifiedAt) } };
    },
  );

  route(
    m,
    { method: 'post', path: '/auth/verify-email', summary: 'Confirm my email with the 6-digit code', tags, body: verifyCodeSchema, middleware: [requireSignedInUser, authLimiter] },
    async (req, _res, { body }) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId! } });
      if (!user.emailVerifiedAt) {
        await consumeCode({ userId: user.id, purpose: 'verify_email', code: body.code });
        await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
        await audit(req, { action: 'auth.email_verified', entityType: 'user', entityId: user.id });
      }
      return { ok: true };
    },
  );

  route(m, { method: 'post', path: '/auth/verify-email/resend', summary: 'Email me a new verification code', tags, middleware: [requireSignedInUser, authLimiter] }, async (req) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId! } });
    if (user.emailVerifiedAt) return { emailSent: false };
    return { emailSent: await sendVerifyCode(user, true) };
  });

  route(m, { method: 'post', path: '/auth/logout', summary: 'Sign out of this device', tags }, async (req, res) => {
    if (req.auth) await prisma.session.update({ where: { id: req.auth.sessionId }, data: { revokedAt: new Date() } });
    clearSessionCookie(res);
    return undefined;
  });

  route(m, { method: 'get', path: '/auth/me', summary: 'Current identity, memberships and session', tags, middleware: [requireAuth] }, async (req) => {
    const auth = req.auth!;
    if (auth.deviceId) {
      const device = await prisma.device.findUniqueOrThrow({
        where: { id: auth.deviceId },
        include: { household: { select: { id: true, name: true, timezone: true } } },
      });
      return {
        kind: 'device',
        device: { id: device.id, name: device.name, householdId: device.householdId },
        memberships: [{ householdId: device.household.id, householdName: device.household.name, role: 'WALL_DISPLAY', memberId: null }],
        session: { id: auth.sessionId, pinElevatedUntil: auth.pinElevatedUntil?.toISOString() ?? null },
      };
    }
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId! },
      include: {
        memberships: { where: { isActive: true }, include: { household: { select: { id: true, name: true } } } },
        preferences: true,
        joinRequests: { where: activeJoinWhere(), include: { household: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
      },
    });
    return {
      kind: 'user',
      user: { id: user.id, email: user.email, displayName: user.displayName, hasPassword: Boolean(user.passwordHash), emailVerified: Boolean(user.emailVerifiedAt) },
      joinRequests: user.joinRequests.map((j) => joinRequestDTO({ ...j, user })),
      preferences: user.preferences?.data ?? {},
      memberships: user.memberships.map((mm) => ({
        householdId: mm.householdId,
        householdName: mm.household.name,
        memberId: mm.id,
        role: mm.role,
        color: mm.color,
      })),
      session: { id: auth.sessionId, pinElevatedUntil: auth.pinElevatedUntil?.toISOString() ?? null },
    };
  });

  route(
    m,
    { method: 'put', path: '/me/preferences', summary: 'Update personal display preferences', tags, body: userPreferencesSchema, middleware: [requireUser] },
    async (req, _res, { body }) => {
      const existing = await prisma.userPreference.findUnique({ where: { userId: req.auth!.userId! } });
      const data = { ...((existing?.data as object) ?? {}), ...body };
      await prisma.userPreference.upsert({
        where: { userId: req.auth!.userId! },
        create: { userId: req.auth!.userId!, data },
        update: { data },
      });
      return data;
    },
  );

  route(m, { method: 'get', path: '/auth/sessions', summary: 'List my active sessions', tags, middleware: [requireUser] }, async (req) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.auth!.userId!, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      current: s.id === req.auth!.sessionId,
    }));
  });

  route(m, { method: 'delete', path: '/auth/sessions/:sessionId', summary: 'Revoke one of my sessions', tags, middleware: [requireUser] }, async (req) => {
    const result = await prisma.session.updateMany({
      where: { id: req.params.sessionId, userId: req.auth!.userId!, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw notFound('Session');
    await audit(req, { action: 'auth.session_revoked', entityType: 'session', entityId: req.params.sessionId });
    return undefined;
  });

  route(
    m,
    { method: 'post', path: '/auth/password-reset/request', summary: 'Request a password reset email', tags, body: passwordResetRequestSchema, status: 202, auth: false, middleware: [authLimiter] },
    async (req, _res, { body }) => {
      const user = await prisma.user.findUnique({ where: { email: body.email } });
      if (user) {
        const token = randomToken(32);
        await prisma.passwordResetToken.create({
          data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60000) },
        });
        await emailAdapter.send({
          to: user.email,
          subject: 'Reset your FamilyHub password',
          text: `Reset your password: ${config.WEB_ORIGIN}/reset-password?token=${token} (valid for 1 hour)`,
        });
        await audit(req, { action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id });
      }
      return { ok: true };
    },
  );

  route(
    m,
    { method: 'post', path: '/auth/password-reset/confirm', summary: 'Set a new password with a reset token', tags, body: passwordResetConfirmSchema, auth: false, middleware: [authLimiter] },
    async (req, _res, { body }) => {
      const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(body.token) } });
      if (!record || record.usedAt || record.expiresAt < new Date()) throw badRequest('This reset link is invalid or has expired');
      await prisma.$transaction([
        prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await hashSecret(body.password) } }),
        prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
        prisma.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
        prisma.user.updateMany({ where: { id: record.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } }),
      ]);
      await audit(req, { action: 'auth.password_reset', entityType: 'user', entityId: record.userId });
      return { ok: true };
    },
  );

  route(
    m,
    { method: 'post', path: '/auth/device/pair', summary: 'Pair a wall display using a one-time code', tags, body: devicePairSchema, auth: false, middleware: [authLimiter] },
    async (req, res, { body }) => {
      const device = await prisma.device.findUnique({ where: { pairingCodeHash: sha256(body.code) } });
      if (!device || device.revokedAt || !device.pairingExpiresAt || device.pairingExpiresAt < new Date()) {
        throw badRequest('This pairing code is invalid or has expired');
      }
      await prisma.device.update({
        where: { id: device.id },
        data: { pairingCodeHash: null, pairingExpiresAt: null, pairedAt: new Date(), lastSeenAt: new Date() },
      });
      await startSession(req, res, { deviceId: device.id, householdId: device.householdId });
      await audit(req, { householdId: device.householdId, action: 'device.paired', entityType: 'device', entityId: device.id });
      return { device: { id: device.id, name: device.name, householdId: device.householdId } };
    },
  );

  // ── Invitations (token based) ──
  route(m, { method: 'get', path: '/invitations/:token', summary: 'Preview an invitation', tags: ['Invitations'], auth: false }, async (req) => {
    const inv = await prisma.invitation.findUnique({
      where: { tokenHash: sha256(String(req.params.token)) },
      include: { household: { select: { name: true } }, invitedBy: { select: { displayName: true } } },
    });
    if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt < new Date()) throw notFound('Invitation');
    return { householdName: inv.household.name, role: inv.role, email: inv.email, invitedBy: inv.invitedBy.displayName };
  });


  // ── Google sign-in (OAuth 2.0 authorization code + PKCE). Disabled unless configured. ──
  const GOOGLE_STATE_COOKIE = 'fh_google_signin';
  router.get('/auth/google/start', (req, res, next) => {
    if (!providerConfigured.google()) return next(new AppError(501, 'NOT_CONFIGURED', 'Google sign-in is not configured'));
    const state = randomToken(24);
    const { verifier, challenge } = pkcePair();
    res.cookie(GOOGLE_STATE_COOKIE, encrypt(JSON.stringify({ state, verifier })), {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: 10 * 60000,
      path: '/api/v1/auth/google',
    });
    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: `${config.API_PUBLIC_URL}/api/v1/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  router.get('/auth/google/callback', async (req, res) => {
    const fail = (reason: string) => res.redirect(`${config.WEB_ORIGIN}/login?error=${encodeURIComponent(reason)}`);
    try {
      const raw = req.cookies[GOOGLE_STATE_COOKIE];
      res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/api/v1/auth/google' });
      if (!raw || typeof req.query.code !== 'string') return fail('google_cancelled');
      const { state, verifier } = JSON.parse(decrypt(raw)) as { state: string; verifier: string };
      if (state !== req.query.state) return fail('invalid_state');
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.GOOGLE_CLIENT_ID,
          client_secret: config.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${config.API_PUBLIC_URL}/api/v1/auth/google/callback`,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
      });
      if (!tokenRes.ok) return fail('token_exchange_failed');
      const tokens = (await tokenRes.json()) as { access_token: string };
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const info = z
        .object({ sub: z.string(), email: z.string().email(), email_verified: z.boolean(), name: z.string().optional() })
        .parse(await infoRes.json());
      if (!info.email_verified) return fail('email_not_verified');
      const email = info.email.toLowerCase();
      let user = await prisma.user.findUnique({ where: { googleSubject: info.sub } });
      user ??= await prisma.user.findUnique({ where: { email } });
      if (user && !user.googleSubject) user = await prisma.user.update({ where: { id: user.id }, data: { googleSubject: info.sub } });
      user ??= await prisma.user.create({
        data: { email, googleSubject: info.sub, displayName: info.name ?? email.split('@')[0]!, emailVerifiedAt: new Date() },
      });
      await startSession(req, res, { userId: user.id });
      await audit(req, { action: 'auth.login_google', entityType: 'user', entityId: user.id });
      res.redirect(config.WEB_ORIGIN);
    } catch {
      fail('google_signin_failed');
    }
  });

  return router;
}

export { unauthorized };
