import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();
beforeEach(async () => {
  await prisma.household.deleteMany();
});
afterAll(() => prisma.$disconnect());

async function home() {
  const household = await prisma.household.create({
    data: {
      name: 'Foundation',
      members: { create: { firstName: 'Owner', displayName: 'Owner', role: 'OWNER' } },
      devices: { create: { name: 'Kitchen' } },
      tasks: { create: { title: 'Task' } },
    },
    include: { members: true, devices: true, tasks: true },
  });
  const member = household.members[0]!;
  const device = household.devices[0]!;
  const task = household.tasks[0]!;
  const note = await prisma.note.create({
    data: { householdId: household.id, title: 'Note', authorMemberId: member.id },
  });
  return { householdId: household.id, member, device, task, note };
}

describe('family foundation database constraints', () => {
  it('provides a household settings singleton with safe defaults and validated local time/call URL', async () => {
    const h = await home();
    const settings = await prisma.householdFeatureSettings.upsert({
      where: { householdId: h.householdId },
      create: { householdId: h.householdId },
      update: {},
    });
    expect(settings).toMatchObject({
      dailySummaryEnabled: true,
      dailySummaryTime: '20:30',
      whatsappCallUrl: null,
    });
    await expect(
      prisma.householdFeatureSettings.create({ data: { householdId: h.householdId } }),
    ).rejects.toThrow();
    await expect(
      prisma.householdFeatureSettings.update({
        where: { householdId: h.householdId },
        data: { dailySummaryTime: '24:00' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.householdFeatureSettings.update({
        where: { householdId: h.householdId },
        data: { whatsappCallUrl: 'https://evil.test' },
      }),
    ).rejects.toThrow();
    await prisma.householdFeatureSettings.update({
      where: { householdId: h.householdId },
      data: { whatsappCallUrl: 'https://call.whatsapp.com/voice/abc123' },
    });
  });

  it('requires one same-household emergency source and stores only the latest optional location', async () => {
    const h = await home();
    const other = await home();
    const base = { householdId: h.householdId, expiresAt: new Date(Date.now() + 600_000) };
    await expect(prisma.emergencySession.create({ data: base })).rejects.toThrow();
    await expect(
      prisma.emergencySession.create({
        data: { ...base, sourceMemberId: h.member.id, sourceDeviceId: h.device.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.emergencySession.create({ data: { ...base, sourceMemberId: other.member.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.emergencySession.create({ data: { ...base, sourceDeviceId: other.device.id } }),
    ).rejects.toThrow();
    const session = await prisma.emergencySession.create({ data: { ...base, sourceDeviceId: h.device.id } });
    expect(session.latitude).toBeNull();
    await expect(
      prisma.emergencySession.update({ where: { id: session.id }, data: { latitude: 5 } }),
    ).rejects.toThrow();
    const locationAt = new Date();
    await prisma.emergencySession.update({
      where: { id: session.id },
      data: { latitude: 5, longitude: 6, accuracyMeters: 10, locationAt },
    });
    await prisma.emergencySession.update({
      where: { id: session.id },
      data: { latitude: 7, longitude: 8, accuracyMeters: null, locationAt, stoppedAt: new Date() },
    });
    expect(await prisma.emergencySession.findMany({ where: { householdId: h.householdId } })).toEqual([
      expect.objectContaining({ latitude: 7, longitude: 8, accuracyMeters: null, locationAt }),
    ]);
    await expect(
      prisma.emergencySession.update({ where: { id: session.id }, data: { latitude: 91 } }),
    ).rejects.toThrow();
    await expect(
      prisma.emergencySession.update({ where: { id: session.id }, data: { accuracyMeters: -1 } }),
    ).rejects.toThrow();
    await expect(
      prisma.emergencySession.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } }),
    ).rejects.toThrow();
  });

  it('requires a same-household note author and preserves history on deactivation/revocation', async () => {
    const h = await home();
    const other = await home();
    await expect(
      prisma.note.create({
        data: { householdId: h.householdId, title: 'Bad', authorMemberId: other.member.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.note.create({
        data: { householdId: h.householdId, title: 'Bad', authorDeviceId: other.device.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.note.create({ data: { householdId: h.householdId, title: 'Bad' } }),
    ).rejects.toThrow();
    const deviceNote = await prisma.note.create({
      data: { householdId: h.householdId, title: 'Device note', authorDeviceId: h.device.id },
    });
    await prisma.householdMember.update({ where: { id: h.member.id }, data: { isActive: false } });
    await prisma.device.update({ where: { id: h.device.id }, data: { revokedAt: new Date() } });
    expect(await prisma.note.count({ where: { householdId: h.householdId } })).toBe(2);
    await expect(prisma.householdMember.delete({ where: { id: h.member.id } })).rejects.toThrow();
    await expect(prisma.device.delete({ where: { id: h.device.id } })).rejects.toThrow();
    expect((await prisma.note.findUniqueOrThrow({ where: { id: deviceNote.id } })).authorDeviceId).toBe(
      h.device.id,
    );
  });

  it('enforces attachment parent XOR on insert/update plus household identity for parents and uploaders', async () => {
    const h = await home();
    const other = await home();
    const base = {
      householdId: h.householdId,
      uploaderMemberId: h.member.id,
      storageKey: randomUUID(),
      mimeType: 'image/png',
      sizeBytes: 100,
      width: 2,
      height: 2,
    };
    await expect(prisma.attachment.create({ data: base })).rejects.toThrow();
    await expect(
      prisma.attachment.create({ data: { ...base, taskId: h.task.id, noteId: h.note.id } }),
    ).rejects.toThrow();
    await expect(prisma.attachment.create({ data: { ...base, taskId: other.task.id } })).rejects.toThrow();
    await expect(prisma.attachment.create({ data: { ...base, noteId: other.note.id } })).rejects.toThrow();
    await expect(
      prisma.attachment.create({ data: { ...base, taskId: h.task.id, uploaderMemberId: other.member.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.attachment.create({
        data: { ...base, taskId: h.task.id, uploaderMemberId: null, uploaderDeviceId: other.device.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.attachment.create({ data: { ...base, taskId: h.task.id, uploaderDeviceId: h.device.id } }),
    ).rejects.toThrow();
    const image = await prisma.attachment.create({ data: { ...base, taskId: h.task.id } });
    await expect(
      prisma.attachment.update({ where: { id: image.id }, data: { noteId: h.note.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.attachment.update({ where: { id: image.id }, data: { taskId: null } }),
    ).rejects.toThrow();
    await expect(
      prisma.attachment.update({ where: { id: image.id }, data: { noteId: other.note.id, taskId: null } }),
    ).rejects.toThrow();
  });

  it('validates image metadata and cascades attachment metadata when either parent is deleted', async () => {
    const h = await home();
    const base = {
      householdId: h.householdId,
      uploaderDeviceId: h.device.id,
      storageKey: randomUUID(),
      noteId: h.note.id,
      mimeType: 'image/webp',
      sizeBytes: 100,
    };
    for (const extra of [
      { mimeType: 'image/svg+xml' },
      { sizeBytes: 0 },
      { sizeBytes: 10_485_761 },
      { width: 1 },
      { width: 0, height: 1 },
    ]) {
      await expect(prisma.attachment.create({ data: { ...base, ...extra } })).rejects.toThrow();
    }
    await prisma.attachment.create({ data: base });
    await prisma.attachment.create({
      data: { ...base, storageKey: randomUUID(), noteId: null, taskId: h.task.id },
    });
    await prisma.note.delete({ where: { id: h.note.id } });
    expect(await prisma.attachment.count()).toBe(1);
    await prisma.task.delete({ where: { id: h.task.id } });
    expect(await prisma.attachment.count()).toBe(0);
  });

  it('deduplicates summaries by household/local-date and fences concurrent claims, retries and stale workers', async () => {
    const h = await home();
    const other = await home();
    const localDate = new Date('2026-10-27T00:00:00Z');
    const run = await prisma.dailySummaryRun.create({ data: { householdId: h.householdId, localDate } });
    await expect(
      prisma.dailySummaryRun.create({ data: { householdId: h.householdId, localDate } }),
    ).rejects.toThrow();
    await prisma.dailySummaryRun.create({ data: { householdId: other.householdId, localDate } });
    const claimedAt = new Date();
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    const tokens = [randomUUID(), randomUUID()];
    const claims = await Promise.all(
      tokens.map((leaseToken) =>
        prisma.dailySummaryRun.updateMany({
          where: { id: run.id, householdId: h.householdId, status: 'PENDING' },
          data: { status: 'CLAIMED', attempts: { increment: 1 }, claimedAt, leaseToken, leaseExpiresAt },
        }),
      ),
    );
    expect(claims.map((claim) => claim.count).sort()).toEqual([0, 1]);
    const first = await prisma.dailySummaryRun.findUniqueOrThrow({ where: { id: run.id } });
    const retryToken = randomUUID();
    await prisma.dailySummaryRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(),
        lastError: 'retryable',
      },
    });
    await prisma.dailySummaryRun.updateMany({
      where: { id: run.id, status: 'FAILED' },
      data: {
        status: 'CLAIMED',
        attempts: { increment: 1 },
        claimedAt,
        leaseToken: retryToken,
        leaseExpiresAt,
      },
    });
    expect(
      (
        await prisma.dailySummaryRun.updateMany({
          where: { id: run.id, leaseToken: first.leaseToken },
          data: { status: 'SENT', leaseToken: null, leaseExpiresAt: null },
        })
      ).count,
    ).toBe(0);
    const payload = { title: 'Today', body: 'Summary', generatedAt: new Date().toISOString() };
    await prisma.dailySummaryRun.updateMany({
      where: { id: run.id, leaseToken: retryToken },
      data: {
        status: 'SENT',
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        sentAt: new Date(),
        payload,
      },
    });
    expect(
      await prisma.dailySummaryRun.findUniqueOrThrow({
        where: { householdId_localDate: { householdId: h.householdId, localDate } },
      }),
    ).toMatchObject({ status: 'SENT', attempts: 2, payload });
    await expect(
      prisma.dailySummaryRun.update({ where: { id: run.id }, data: { status: 'CLAIMED' } }),
    ).rejects.toThrow();
    await expect(
      prisma.dailySummaryRun.update({ where: { id: run.id }, data: { attempts: -1 } }),
    ).rejects.toThrow();
  });

  it('allows exactly one worker to reclaim an expired lease without duplicating the local-date run', async () => {
    const h = await home();
    const run = await prisma.dailySummaryRun.create({
      data: {
        householdId: h.householdId,
        localDate: new Date('2026-10-27'),
        status: 'CLAIMED',
        attempts: 1,
        claimedAt: new Date(Date.now() - 120_000),
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const now = new Date();
    const claims = await Promise.all(
      [1, 2].map(() =>
        prisma.dailySummaryRun.updateMany({
          where: { id: run.id, householdId: h.householdId, status: 'CLAIMED', leaseExpiresAt: { lte: now } },
          data: {
            leaseToken: randomUUID(),
            claimedAt: now,
            leaseExpiresAt: new Date(now.getTime() + 60_000),
            attempts: { increment: 1 },
          },
        }),
      ),
    );
    expect(claims.map((claim) => claim.count).sort()).toEqual([0, 1]);
    expect(await prisma.dailySummaryRun.count({ where: { householdId: h.householdId } })).toBe(1);
    expect(await prisma.dailySummaryRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      attempts: 2,
    });
  });

  it('cascades household deletion across all foundation rows despite retained actor references', async () => {
    const h = await home();
    await prisma.emergencySession.create({
      data: {
        householdId: h.householdId,
        sourceMemberId: h.member.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.attachment.create({
      data: {
        householdId: h.householdId,
        uploaderDeviceId: h.device.id,
        noteId: h.note.id,
        storageKey: randomUUID(),
        mimeType: 'image/jpeg',
        sizeBytes: 100,
      },
    });
    await prisma.dailySummaryRun.create({
      data: { householdId: h.householdId, localDate: new Date('2026-10-27') },
    });
    await prisma.householdFeatureSettings.create({ data: { householdId: h.householdId } });
    await prisma.household.delete({ where: { id: h.householdId } });
    expect(
      await Promise.all([
        prisma.emergencySession.count(),
        prisma.note.count(),
        prisma.attachment.count(),
        prisma.householdFeatureSettings.count(),
        prisma.dailySummaryRun.count(),
      ]),
    ).toEqual([0, 0, 0, 0, 0]);
  });
});
