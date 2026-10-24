import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { logger } from '../logger.js';

export async function audit(
  req: Request | null,
  entry: {
    householdId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
  tx: Tx = prisma,
) {
  try {
    const auth = req?.auth;
    await tx.auditLog.create({
      data: {
        householdId: entry.householdId ?? null,
        actorUserId: auth?.userId ?? null,
        actorDeviceId: auth?.deviceId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata ?? {},
        ipAddress: req?.ip ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err, action: entry.action }, 'Failed to write audit log');
  }
}
