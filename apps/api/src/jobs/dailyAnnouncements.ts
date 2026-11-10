import { DateTime } from 'luxon';
import { dueSlot, type LocalClock } from '@familyhub/shared';
import { prisma } from '../db.js';
import { notify } from '../lib/notify.js';

function clockFor(now: Date, timezone: string): LocalClock | null {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) return null;
  return { isoDate: local.toISODate()!, weekday: local.weekday, day: local.day, hour: local.hour, minute: local.minute };
}

/** Durable, idempotent delivery: the feed row must exist before the slot is claimed with a monotonic updateMany. */
async function deliverSlot(opts: { householdId: string; dedupeKey: string; type: string; title: string; body?: string | null; url: string; claim: () => Promise<number> }) {
  const created = await notify(opts.householdId, { type: opts.type, title: opts.title, body: opts.body ?? undefined, url: opts.url, householdFeed: true }, { dedupeKey: opts.dedupeKey });
  const feedExists = created > 0 || Boolean(await prisma.notification.findUnique({ where: { dedupeKey: `${opts.dedupeKey}:feed` }, select: { id: true } }));
  if (!feedExists) return 0;
  return opts.claim();
}

/** Send each scheduled household announcement once per slot (date + time) on its chosen weekdays or month days. */
export async function runDailyAnnouncements(now = new Date()) {
  const announcements = await prisma.announcement.findMany({
    where: { repeatDaily: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    include: { household: { select: { timezone: true } } },
    orderBy: { id: 'asc' },
    take: 2000,
  });
  let sent = 0;
  for (const a of announcements) {
    const clock = clockFor(now, a.household.timezone);
    if (!clock) continue;
    const lastSlot = a.lastNotifiedSlot ?? (a.lastNotifiedLocalDate && a.dailyTime ? `${a.lastNotifiedLocalDate.toISOString().slice(0, 10)}T${a.dailyTime}` : null);
    const slot = dueSlot(a, clock, lastSlot, a.dailyTime);
    if (!slot) continue;
    sent += await deliverSlot({
      householdId: a.householdId,
      dedupeKey: `announcement-daily:${a.id}:${slot}`,
      type: 'announcement.daily',
      title: a.title,
      body: a.body,
      url: '/announcements',
      claim: async () => {
        const r = await prisma.announcement.updateMany({
          where: { id: a.id, OR: [{ lastNotifiedSlot: null }, { lastNotifiedSlot: { lt: slot } }] },
          data: { lastNotifiedSlot: slot, lastNotifiedLocalDate: new Date(`${clock.isoDate}T00:00:00.000Z`) },
        });
        return r.count;
      },
    });
  }
  return sent;
}

/** Notes with a repeat schedule are re-surfaced (and spoken on displays) at their chosen times. */
export async function runNoteReminders(now = new Date()) {
  const notes = await prisma.note.findMany({
    where: { repeatDaily: true },
    include: { household: { select: { timezone: true } } },
    orderBy: { id: 'asc' },
    take: 2000,
  });
  let sent = 0;
  for (const n of notes) {
    const clock = clockFor(now, n.household.timezone);
    if (!clock) continue;
    const slot = dueSlot(n, clock, n.lastNotifiedSlot);
    if (!slot) continue;
    sent += await deliverSlot({
      householdId: n.householdId,
      dedupeKey: `note-reminder:${n.id}:${slot}`,
      type: 'note.reminder',
      title: n.title,
      body: n.body ? n.body.slice(0, 500) : null,
      url: '/notes',
      claim: async () => {
        const r = await prisma.note.updateMany({
          where: { id: n.id, OR: [{ lastNotifiedSlot: null }, { lastNotifiedSlot: { lt: slot } }] },
          data: { lastNotifiedSlot: slot },
        });
        return r.count;
      },
    });
  }
  return sent;
}
