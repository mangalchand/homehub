import { createHmac, randomInt } from 'node:crypto';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { safeEqual } from './crypto.js';
import { emailAdapter } from './email.js';
import { AppError } from './errors.js';

export type CodePurpose = 'verify_email' | 'join_requester' | 'join_admin' | 'login';

const TTL_MS = 15 * 60000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30_000;

const hash = (purpose: CodePurpose, userId: string, code: string, subjectId?: string | null) =>
  createHmac('sha256', Buffer.from(config.ENCRYPTION_KEY, 'base64')).update(`${purpose}:${userId}:${subjectId ?? ''}:${code}`).digest('hex');

/** Creates a fresh 6-digit code (invalidating older ones) and emails it. Returns whether the email was sent. */
export async function issueCode(opts: { userId: string; email: string; purpose: CodePurpose; subjectId?: string | null; subject: string; intro: string; enforceCooldown?: boolean }) {
  const where = { userId: opts.userId, purpose: opts.purpose, subjectId: opts.subjectId ?? null, usedAt: null };
  if (opts.enforceCooldown) {
    const last = await prisma.emailCode.findFirst({ where: { ...where, usedAt: undefined }, orderBy: { createdAt: 'desc' } });
    if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new AppError(429, 'RATE_LIMITED', 'Please wait 30 seconds before asking for another code');
    }
  }
  await prisma.emailCode.updateMany({ where, data: { usedAt: new Date() } });
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const row = await prisma.emailCode.create({
    data: { userId: opts.userId, purpose: opts.purpose, subjectId: opts.subjectId ?? null, codeHash: hash(opts.purpose, opts.userId, code, opts.subjectId), expiresAt: new Date(Date.now() + TTL_MS) },
  });
  const sent = await emailAdapter.send({ to: opts.email, subject: opts.subject, text: `${opts.intro}\n\nYour FamilyHub code: ${code}\n\nIt expires in 15 minutes. If you didn't ask for this, you can ignore this email.` });
  if (!sent && config.NODE_ENV === 'production') {
    await prisma.emailCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    throw new AppError(503, 'EMAIL_DELIVERY_FAILED', 'The email service could not send a code. In AWS SES sandbox, both sender and recipient must be verified. Ask the home admin to check email setup.');
  }
  return sent;
}

/** Checks and consumes a code. Throws a friendly error on mismatch/expiry. */
export async function consumeCode(opts: { userId: string; purpose: CodePurpose; subjectId?: string | null; code: string }) {
  const row = await prisma.emailCode.findFirst({
    where: { userId: opts.userId, purpose: opts.purpose, subjectId: opts.subjectId ?? null, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row || row.attempts >= MAX_ATTEMPTS) throw new AppError(400, 'CODE_EXPIRED', 'This code has expired. Ask for a new one.');
  const attempt = await prisma.emailCode.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
  if (!attempt.count) throw new AppError(400, 'CODE_EXPIRED', 'This code has expired. Ask for a new one.');
  if (!safeEqual(row.codeHash, hash(opts.purpose, opts.userId, opts.code.trim(), opts.subjectId))) {
    throw new AppError(400, 'CODE_INVALID', 'That code is not right. Check the latest email and try again.');
  }
  const consumed = await prisma.emailCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (!consumed.count) throw new AppError(400, 'CODE_EXPIRED', 'This code has already been used. Ask for a new one.');
}
