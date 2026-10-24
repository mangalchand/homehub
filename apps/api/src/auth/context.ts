import type { NextFunction, Request, Response } from 'express';
import type { Household, HouseholdMember } from '@prisma/client';
import { can, type Actor, type Capability } from '@familyhub/shared';
import { prisma } from '../db.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

export interface HouseholdContext {
  householdId: string;
  household: Household;
  actor: Actor;
  /** Present for member (user) sessions. */
  member: HouseholdMember | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: HouseholdContext;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves the caller's membership in :householdId. Non-members get 404 so household ids cannot be probed. */
export async function householdContext(req: Request, _res: Response, next: NextFunction) {
  try {
    const auth = req.auth;
    if (!auth) throw unauthorized();
    const householdId = req.params.householdId;
    if (!householdId || !UUID.test(householdId)) throw notFound('Household');
    const household = await prisma.household.findUnique({ where: { id: householdId } });
    if (!household) throw notFound('Household');

    if (auth.deviceId) {
      if (auth.deviceHouseholdId !== householdId) throw notFound('Household');
      req.ctx = {
        householdId,
        household,
        member: null,
        actor: {
          kind: 'device',
          deviceId: auth.deviceId,
          elevated: Boolean(auth.pinElevatedUntil && auth.pinElevatedUntil > new Date()),
        },
      };
      return next();
    }

    const member = await prisma.householdMember.findFirst({
      where: { householdId, userId: auth.userId!, isActive: true },
    });
    if (!member) throw notFound('Household');
    if (member.accessExpiresAt && member.accessExpiresAt < new Date()) {
      throw forbidden('Your guest access to this household has expired');
    }
    req.ctx = {
      householdId,
      household,
      member,
      actor: { kind: 'member', memberId: member.id, userId: auth.userId!, role: member.role },
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireCap(cap: Capability) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx) return next(unauthorized());
    if (!can(req.ctx.actor, cap)) {
      const hint = req.ctx.actor.kind === 'device' ? ' Enter the household PIN to unlock this action.' : '';
      return next(forbidden(`You do not have permission to do that.${hint}`));
    }
    next();
  };
}

export function assertCap(req: Request, cap: Capability) {
  if (!req.ctx || !can(req.ctx.actor, cap)) {
    const hint = req.ctx?.actor.kind === 'device' ? ' Enter the household PIN to unlock this action.' : '';
    throw forbidden(`You do not have permission to do that.${hint}`);
  }
}

export function ctx(req: Request): HouseholdContext {
  if (!req.ctx) throw unauthorized();
  return req.ctx;
}

export function actorMemberId(req: Request): string | null {
  const a = ctx(req).actor;
  return a.kind === 'member' ? a.memberId : null;
}
