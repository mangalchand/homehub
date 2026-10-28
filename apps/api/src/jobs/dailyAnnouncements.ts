import { DateTime } from 'luxon';
import { prisma } from '../db.js';
import { notify } from '../lib/notify.js';

/** Send each scheduled household announcement once per local calendar day. */
export async function runDailyAnnouncements(now = new Date()) {
  const announcements = await prisma.announcement.findMany({
    where: {
      repeatDaily: true,
      dailyTime: { not: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { household: { select: { timezone: true } } },
    orderBy: { id: 'asc' },
    take: 2000,
  });
  let sent = 0;
  for (const announcement of announcements) {
    const local = DateTime.fromJSDate(now, { zone: announcement.household.timezone });
    if (!local.isValid || !announcement.dailyTime) continue;
    const [hour, minute] = announcement.dailyTime.split(':').map(Number);
    if (local.hour * 60 + local.minute < hour! * 60 + minute!) continue;
    const localDate = local.toISODate()!;
    if (announcement.lastNotifiedLocalDate?.toISOString().slice(0, 10) === localDate) continue;
    const dedupeKey = `announcement-daily:${announcement.id}:${localDate}`;
    const created = await notify(
      announcement.householdId,
      {
        type: 'announcement.daily',
        title: announcement.title,
        body: announcement.body ?? undefined,
        url: '/announcements',
        householdFeed: true,
      },
      { dedupeKey },
    );
    const feedExists =
      created > 0 ||
      Boolean(
        await prisma.notification.findUnique({
          where: { dedupeKey: `${dedupeKey}:feed` },
          select: { id: true },
        }),
      );
    if (!feedExists) continue;
    const date = new Date(`${localDate}T00:00:00.000Z`);
    const claimed = await prisma.announcement.updateMany({
      where: {
        id: announcement.id,
        OR: [{ lastNotifiedLocalDate: null }, { lastNotifiedLocalDate: { lt: date } }],
      },
      data: { lastNotifiedLocalDate: date },
    });
    sent += claimed.count;
  }
  return sent;
}
