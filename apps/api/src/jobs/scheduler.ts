import { DateTime } from 'luxon';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { notify } from '../lib/notify.js';
import { expandOccurrences } from '../calendar/recurrence.js';
import { retryPendingPushes, runDueSyncs } from '../calendar/sync.js';
import { runEveningSummaries } from './eveningSummary.js';
import { cleanupExpiredEmergencySessions } from '../routes/safety.js';
import { retryAttachmentObjectCleanup } from '../lib/attachments.js';
import { runDailyAnnouncements } from './dailyAnnouncements.js';

/** Create in-app reminder notifications for events starting soon. Dedupe keys make this idempotent. */
export async function generateEventReminders(now = new Date(), horizonMinutes = 24 * 60) {
  const horizon = new Date(now.getTime() + horizonMinutes * 60000);
  const events = await prisma.calendarEvent.findMany({
    where: {
      deletedAt: null,
      status: { not: 'CANCELLED' },
      reminderMinutes: { isEmpty: false },
      OR: [
        { rrule: { not: null }, startAt: { lt: horizon } },
        { rrule: null, startAt: { gte: now, lt: horizon } },
      ],
    },
    include: { assignments: true, calendar: true },
    take: 2000,
  });
  let created = 0;
  for (const ev of events) {
    for (const occ of expandOccurrences(ev, now, horizon)) {
      for (const minutes of ev.reminderMinutes) {
        const remindAt = new Date(occ.start.getTime() - minutes * 60000);
        if (remindAt > now || occ.start < now) continue;
        const dedupeKey = `evrem:${ev.id}:${occ.start.toISOString()}:${minutes}`;
        const when = DateTime.fromJSDate(occ.start).setZone(ev.timezone).toFormat('h:mm a');
        created += await notify(
          ev.householdId,
          {
            type: 'event.reminder',
            title: ev.title,
            body: ev.allDay ? 'Today' : `Starts at ${when}`,
            url: '/calendar',
            data: { eventId: ev.id, startAt: occ.start.toISOString() },
            householdFeed:
              !ev.isPrivate && ev.calendar.visibility === 'HOUSEHOLD' && ev.calendar.showOnWallDisplay,
          },
          { to: ev.assignments.map((a) => a.memberId), dedupeKey },
        );
      }
    }
  }
  return created;
}

let timers: NodeJS.Timeout[] = [];

async function safely(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    logger.error({ err, job: name }, 'background job failed');
  }
}

export function startScheduler() {
  logger.info('background scheduler started');
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      await safely(name, fn);
      running = false;
    }, ms);
    t.unref();
    timers.push(t);
  };
  every(30_000, 'calendar-sync', () => runDueSyncs());
  every(60_000, 'event-push-retry', () => retryPendingPushes());
  every(60_000, 'event-reminders', () => generateEventReminders());
  every(60_000, 'daily-announcements', () => runDailyAnnouncements());
  void safely('daily-announcements-startup', () => runDailyAnnouncements());
  every(60_000, 'evening-summary', () => runEveningSummaries());
  void safely('evening-summary-catchup', () => runEveningSummaries());
  every(60_000, 'safety-expiry', () => cleanupExpiredEmergencySessions());
  void safely('safety-expiry-startup', () => cleanupExpiredEmergencySessions());
  every(60_000, 'attachment-cleanup', () => retryAttachmentObjectCleanup());
  void safely('attachment-cleanup-startup', () => retryAttachmentObjectCleanup());
  every(3_600_000, 'cleanup', async () => {
    const now = new Date();
    await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } });
    await prisma.session.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(now.getTime() - 30 * 86400000) } }],
      },
    });
  });
}

export function stopScheduler() {
  timers.forEach(clearInterval);
  timers = [];
}
