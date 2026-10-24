import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

export const MEMBER_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

export const DEFAULT_WIDGETS: Prisma.InputJsonValue = [
  { id: 'agenda', type: 'agenda', visible: true, size: 'lg', config: {} },
  { id: 'tasks', type: 'tasks', visible: true, size: 'md', config: {} },
  { id: 'chores', type: 'chores', visible: true, size: 'md', config: {} },
  { id: 'lists', type: 'lists', visible: true, size: 'md', config: {} },
  { id: 'announcements', type: 'announcements', visible: true, size: 'md', config: {} },
  { id: 'birthdays', type: 'birthdays', visible: true, size: 'sm', config: {} },
  { id: 'weather', type: 'weather', visible: true, size: 'sm', config: {} },
];

export async function createHouseholdWithDefaults(input: {
  userId: string;
  name: string;
  timezone: string;
  ownerFirstName: string;
  ownerColor?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const household = await tx.household.create({
      data: { name: input.name, timezone: input.timezone, settings: { temperatureUnit: 'celsius', clockFormat: '12h' } },
    });
    const owner = await tx.householdMember.create({
      data: {
        householdId: household.id,
        userId: input.userId,
        firstName: input.ownerFirstName,
        displayName: input.ownerFirstName,
        role: 'OWNER',
        color: input.ownerColor ?? MEMBER_COLORS[0]!,
      },
    });
    await tx.calendar.create({
      data: { householdId: household.id, name: 'Family', color: '#6366f1', category: 'FAMILY', visibility: 'HOUSEHOLD' },
    });
    await tx.calendar.create({
      data: {
        householdId: household.id,
        name: `${input.ownerFirstName}'s calendar`,
        color: owner.color,
        category: 'PERSONAL',
        visibility: 'HOUSEHOLD',
        ownerMemberId: owner.id,
      },
    });
    await tx.list.create({ data: { householdId: household.id, name: 'Groceries', type: 'GROCERY', icon: 'shopping-cart' } });
    await tx.dashboardLayout.create({
      data: { householdId: household.id, name: 'Family overview', preset: 'FAMILY_OVERVIEW', widgets: DEFAULT_WIDGETS, isDefault: true },
    });
    return { household, owner };
  });
}

/** Full household export (no password hashes, tokens, or encrypted secrets). */
export async function exportHousehold(householdId: string) {
  const [household, members, calendars, events, tasks, completions, rewards, rewardTx, lists, announcements, layouts] =
    await Promise.all([
      prisma.household.findUniqueOrThrow({
        where: { id: householdId },
        select: { id: true, name: true, timezone: true, locale: true, weekStartsOn: true, settings: true, createdAt: true },
      }),
      prisma.householdMember.findMany({ where: { householdId } }),
      prisma.calendar.findMany({
        where: { householdId, deletedAt: null },
        include: { shares: true, connection: { select: { syncMode: true, externalCalendarId: true, refreshIntervalMinutes: true } } },
      }),
      prisma.calendarEvent.findMany({ where: { householdId, deletedAt: null }, include: { assignments: true, attendees: true } }),
      prisma.task.findMany({ where: { householdId, deletedAt: null }, include: { assignments: true } }),
      prisma.choreCompletion.findMany({ where: { householdId } }),
      prisma.reward.findMany({ where: { householdId } }),
      prisma.rewardTransaction.findMany({ where: { householdId } }),
      prisma.list.findMany({ where: { householdId, deletedAt: null }, include: { items: { where: { deletedAt: null } } } }),
      prisma.announcement.findMany({ where: { householdId } }),
      prisma.dashboardLayout.findMany({ where: { householdId } }),
    ]);
  return {
    format: 'familyhub-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    household,
    members: members.map(({ userId, ...m }) => ({ ...m, hasLogin: Boolean(userId) })),
    calendars,
    events,
    tasks,
    choreCompletions: completions,
    rewards,
    rewardTransactions: rewardTx,
    lists,
    announcements,
    dashboardLayouts: layouts,
  };
}
