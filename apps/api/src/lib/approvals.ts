import { config } from '../config.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { randomToken, sha256 } from './crypto.js';
import { emailAdapter } from './email.js';

const ownerEmail = () => config.PLATFORM_OWNER_EMAIL.trim().toLowerCase();
const origin = () => config.WEB_ORIGIN.split(',')[0]!.trim().replace(/\/$/, '');

/** New accounts and homes need the platform owner's approval, except the owner's own. */
export const initialApproval = (email: string) => (!ownerEmail() || email.trim().toLowerCase() === ownerEmail() ? 'APPROVED' : 'PENDING');

export async function requestApproval(kind: 'user' | 'household', id: string, status: string, summary: string) {
  if (status !== 'PENDING' || !ownerEmail()) return false;
  const token = randomToken(32);
  const hash = sha256(token);
  const prev = kind === 'user'
    ? (await prisma.user.findUnique({ where: { id }, select: { approvalTokenHash: true } }))?.approvalTokenHash
    : (await prisma.household.findUnique({ where: { id }, select: { approvalTokenHash: true } }))?.approvalTokenHash;
  if (kind === 'user') await prisma.user.update({ where: { id }, data: { approvalTokenHash: hash } });
  else await prisma.household.update({ where: { id }, data: { approvalTokenHash: hash } });
  const sent = await emailAdapter.send({
    to: ownerEmail(),
    subject: kind === 'user' ? 'FamilyHub: approve a new account' : 'FamilyHub: approve a new home',
    text: `${summary}\n\nApprove or reject it here (the link works once):\n${origin()}/api/v1/approvals/${token}\n\nUntil you approve, they cannot use FamilyHub.`,
  });
  if (!sent) {
    logger.warn({ kind, id }, '[approval] approval email was not delivered');
    // Keep the link from an earlier email working, since the new one never arrived.
    if (prev) {
      if (kind === 'user') await prisma.user.updateMany({ where: { id, approvalTokenHash: hash }, data: { approvalTokenHash: prev } });
      else await prisma.household.updateMany({ where: { id, approvalTokenHash: hash }, data: { approvalTokenHash: prev } });
    }
  }
  return sent;
}

export async function tellDecision(to: string, what: string, approved: boolean) {
  await emailAdapter.send({
    to,
    subject: approved ? `Your FamilyHub ${what} is approved` : `Your FamilyHub ${what} was not approved`,
    text: approved ? `Good news: your FamilyHub ${what} has been approved. Open ${origin()} to get started.` : `Your FamilyHub ${what} was not approved. Reply to the person who invited you if you think this is a mistake.`,
  });
}
