import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.js';

export const SESSION_COOKIE = 'fh_session';
export const CSRF_COOKIE = 'fh_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthInfo {
  sessionId: string;
  userId: string | null;
  deviceId: string | null;
  /** Household bound to a device session. */
  deviceHouseholdId: string | null;
  pinElevatedUntil: Date | null;
  /** False until a personal account confirms its email with a code. Always true for devices. */
  emailVerified: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export async function startSession(
  req: Request,
  res: Response,
  subject: { userId: string } | { deviceId: string; householdId: string },
) {
  const token = randomToken(32);
  const days = 'deviceId' in subject ? config.DEVICE_SESSION_TTL_DAYS : config.SESSION_TTL_DAYS;
  const ttlMs = days * 86400000;
  const session = await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      userId: 'userId' in subject ? subject.userId : null,
      deviceId: 'deviceId' in subject ? subject.deviceId : null,
      householdId: 'deviceId' in subject ? subject.householdId : null,
      userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
      ipAddress: req.ip ?? null,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions(ttlMs));
  return session;
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Non-failing: attaches req.auth when a valid session cookie is present. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) return next();
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { device: { select: { revokedAt: true } }, user: { select: { emailVerifiedAt: true } } },
    });
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt < now || session.device?.revokedAt) return next();
    req.auth = {
      sessionId: session.id,
      userId: session.userId,
      deviceId: session.deviceId,
      deviceHouseholdId: session.householdId,
      pinElevatedUntil: session.pinElevatedUntil,
      emailVerified: !session.userId || Boolean(session.user?.emailVerifiedAt),
    };
    if (now.getTime() - session.lastSeenAt.getTime() > 5 * 60000) {
      void prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } }).catch(() => undefined);
      if (session.deviceId) {
        void prisma.device.update({ where: { id: session.deviceId }, data: { lastSeenAt: now } }).catch(() => undefined);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  next();
}

export const emailNotVerified = () => new AppError(403, 'EMAIL_NOT_VERIFIED', 'Confirm your email with the code we sent before continuing');

/** Personal account, even if the email is not confirmed yet (used by the verification endpoints). */
export function requireSignedInUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  if (!req.auth.userId) return next(forbidden('This action requires a personal account, not a shared display'));
  next();
}

/** Personal account with a confirmed email. */
export function requireUser(req: Request, res: Response, next: NextFunction) {
  requireSignedInUser(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.auth!.emailVerified) return next(emailNotVerified());
    next();
  });
}

/** Double-submit CSRF protection for cookie-authenticated, state-changing requests. */
export function csrfProtection(exemptPrefixes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    let token = req.cookies?.[CSRF_COOKIE] as string | undefined;
    if (!token) {
      token = randomToken(24);
      res.cookie(CSRF_COOKIE, token, { httpOnly: false, secure: config.COOKIE_SECURE, sameSite: 'lax', path: '/' });
      req.cookies[CSRF_COOKIE] = token;
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (exemptPrefixes.some((p) => req.path.startsWith(p))) return next();
    const header = req.get(CSRF_HEADER);
    if (!header || !safeEqual(header, token)) {
      return next(forbidden('Missing or invalid CSRF token'));
    }
    next();
  };
}
