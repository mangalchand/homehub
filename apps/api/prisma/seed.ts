/* Demo seed: one household with a realistic week of data. Safe to re-run (replaces the demo household). */
import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { hashSecret } from '../src/auth/passwords.js';
import { createHouseholdWithDefaults } from '../src/services/households.js';

const prisma = new PrismaClient();
const DEMO_EMAIL = 'demo@familyhub.local';
const DEMO_PASSWORD = 'FamilyHub!2024';
const PARTNER_EMAIL = 'sam@familyhub.local';
const TZ = 'America/New_York';

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL }, include: { memberships: true } });
  if (existing) {
    for (const m of existing.memberships) await prisma.household.deleteMany({ where: { id: m.householdId } });
    await prisma.user.deleteMany({ where: { email: { in: [DEMO_EMAIL, PARTNER_EMAIL] } } });
  }
  const passwordHash = await hashSecret(DEMO_PASSWORD);
  const alex = await prisma.user.create({ data: { email: DEMO_EMAIL, displayName: 'Alex Rivera', passwordHash, emailVerifiedAt: new Date() } });
  const samUser = await prisma.user.create({ data: { email: PARTNER_EMAIL, displayName: 'Sam Rivera', passwordHash, emailVerifiedAt: new Date() } });

  const { household, owner } = await createHouseholdWithDefaults({ userId: alex.id, name: 'The Rivera Family', timezone: TZ, ownerFirstName: 'Alex', ownerColor: '#6366f1' });
  await prisma.household.update({ where: { id: household.id }, data: { pinHash: await hashSecret('1234') } });
  const hid = household.id;
  const sam = await prisma.householdMember.create({ data: { householdId: hid, userId: samUser.id, firstName: 'Sam', displayName: 'Sam', role: 'ADULT_ADMIN', color: '#ec4899', birthDate: new Date('1986-04-12') } });
  const maya = await prisma.householdMember.create({ data: { householdId: hid, firstName: 'Maya', displayName: 'Maya', role: 'CHILD', color: '#f59e0b', birthDate: new Date('2014-09-03') } });
  const leo = await prisma.householdMember.create({ data: { householdId: hid, firstName: 'Leo', displayName: 'Leo', role: 'CHILD', color: '#10b981', birthDate: new Date('2017-01-21') } });
  const grandma = await prisma.householdMember.create({ data: { householdId: hid, firstName: 'Rosa', displayName: 'Grandma Rosa', role: 'GUEST', color: '#8b5cf6', birthDate: new Date('1952-11-30'), emergencyContact: { name: 'Rosa Rivera', phone: '+1 555 0100', relation: 'Grandmother' } } });

  const family = await prisma.calendar.findFirstOrThrow({ where: { householdId: hid, name: 'Family' } });
  const school = await prisma.calendar.create({ data: { householdId: hid, name: 'School', color: '#f97316', category: 'SCHOOL' } });
  const samWork = await prisma.calendar.create({ data: { householdId: hid, name: "Sam's work", color: '#64748b', category: 'WORK', visibility: 'BUSY_ONLY', ownerMemberId: sam.id } });
  const alexPrivate = await prisma.calendar.findFirst({ where: { householdId: hid, ownerMemberId: owner.id } });

  const today = DateTime.now().setZone(TZ).startOf('day');
  const monday = today.minus({ days: today.weekday - 1 });
  const at = (d: DateTime, h: number, min = 0) => d.set({ hour: h, minute: min }).toJSDate();
  type Ev = { cal: string; title: string; start: Date; end: Date; members: string[]; rrule?: string; location?: string; allDay?: boolean; isPrivate?: boolean; reminder?: number[] };
  const evs: Ev[] = [
    { cal: school.id, title: 'School drop-off', start: at(monday, 7, 45), end: at(monday, 8, 15), members: [maya.id, leo.id, owner.id], rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', reminder: [15] },
    { cal: family.id, title: 'Soccer practice', start: at(monday.plus({ days: 1 }), 16, 30), end: at(monday.plus({ days: 1 }), 18), members: [maya.id], rrule: 'FREQ=WEEKLY;BYDAY=TU,TH', location: 'Riverside Park' },
    { cal: family.id, title: 'Piano lesson', start: at(monday.plus({ days: 2 }), 17), end: at(monday.plus({ days: 2 }), 17, 45), members: [leo.id], rrule: 'FREQ=WEEKLY;BYDAY=WE', location: 'Ms. Chen’s studio' },
    { cal: family.id, title: 'Family movie night', start: at(monday.plus({ days: 4 }), 19), end: at(monday.plus({ days: 4 }), 21), members: [owner.id, sam.id, maya.id, leo.id], rrule: 'FREQ=WEEKLY;BYDAY=FR' },
    { cal: family.id, title: 'Dentist – Maya', start: at(today.plus({ days: 2 }), 15, 30), end: at(today.plus({ days: 2 }), 16, 15), members: [maya.id, sam.id], location: 'Bright Smiles Dental', reminder: [60] },
    { cal: family.id, title: 'Grandma visits', start: today.plus({ days: 5 }).toJSDate(), end: today.plus({ days: 7 }).toJSDate(), members: [grandma.id], allDay: true },
    { cal: school.id, title: 'Science fair', start: at(today.plus({ days: 9 }), 18), end: at(today.plus({ days: 9 }), 20), members: [maya.id], location: 'Lincoln Elementary gym' },
    { cal: samWork.id, title: 'Board meeting', start: at(today.plus({ days: 1 }), 10), end: at(today.plus({ days: 1 }), 12), members: [sam.id] },
    { cal: samWork.id, title: 'Client call', start: at(today, 14), end: at(today, 15), members: [sam.id] },
    { cal: family.id, title: 'Soccer team photo', start: at(monday.plus({ days: 1 }), 17), end: at(monday.plus({ days: 1 }), 17, 30), members: [maya.id], location: 'Riverside Park' },
  ];
  if (alexPrivate) evs.push({ cal: alexPrivate.id, title: 'Surprise party planning', start: at(today.plus({ days: 3 }), 12), end: at(today.plus({ days: 3 }), 13), members: [owner.id], isPrivate: true });
  for (const e of evs) {
    await prisma.calendarEvent.create({
      data: {
        householdId: hid, calendarId: e.cal, title: e.title, startAt: e.start, endAt: e.end, allDay: e.allDay ?? false, timezone: e.allDay ? 'UTC' : TZ,
        rrule: e.rrule ?? null, location: e.location ?? null, isPrivate: e.isPrivate ?? false, reminderMinutes: e.reminder ?? [], createdById: alex.id,
        assignments: { create: e.members.map((memberId) => ({ memberId })) },
      },
    });
  }

  const chores: { title: string; icon: string; points: number; rrule?: string; members: string[]; approval?: boolean; rotate?: boolean }[] = [
    { title: 'Make bed', icon: 'bed', points: 5, rrule: 'FREQ=DAILY', members: [maya.id, leo.id] },
    { title: 'Feed the dog', icon: 'dog', points: 10, rrule: 'FREQ=DAILY', members: [maya.id, leo.id], rotate: true },
    { title: 'Empty dishwasher', icon: 'utensils', points: 15, rrule: 'FREQ=DAILY', members: [maya.id], approval: true },
    { title: 'Tidy bedroom', icon: 'sparkles', points: 20, rrule: 'FREQ=WEEKLY;BYDAY=SA', members: [leo.id], approval: true },
    { title: 'Take out recycling', icon: 'recycle', points: 10, rrule: 'FREQ=WEEKLY;BYDAY=TU', members: [maya.id] },
  ];
  for (const c of chores) {
    await prisma.task.create({
      data: {
        householdId: hid, kind: 'CHORE', title: c.title, icon: c.icon, points: c.points, rrule: c.rrule ?? null, requiresApproval: c.approval ?? false,
        rotate: c.rotate ?? false, dueAt: today.toJSDate(), createdById: alex.id, assignments: { create: c.members.map((memberId, position) => ({ memberId, position })) },
      },
    });
  }
  const tasks = [
    { title: 'Renew car registration', priority: 'HIGH' as const, due: today.plus({ days: 3 }), members: [owner.id] },
    { title: 'Sign field-trip permission slip', priority: 'MEDIUM' as const, due: today.plus({ days: 1 }), members: [sam.id] },
    { title: 'Book summer camp', priority: 'LOW' as const, due: today.plus({ days: 14 }), members: [owner.id, sam.id] },
  ];
  for (const t of tasks) {
    await prisma.task.create({ data: { householdId: hid, kind: 'TASK', title: t.title, priority: t.priority, dueAt: t.due.set({ hour: 17 }).toJSDate(), createdById: alex.id, assignments: { create: t.members.map((memberId, position) => ({ memberId, position })) } } });
  }

  for (const r of [
    { title: '30 min extra screen time', icon: 'tv', cost: 50 },
    { title: 'Pick Friday dinner', icon: 'pizza', cost: 100 },
    { title: 'Trip to the trampoline park', icon: 'party', cost: 300 },
  ]) await prisma.reward.create({ data: { householdId: hid, ...r } });
  for (const [memberId, points] of [[maya.id, 120], [leo.id, 65]] as const) {
    await prisma.rewardTransaction.create({ data: { householdId: hid, memberId, type: 'ADJUST', status: 'APPROVED', points, note: 'Starting balance', createdById: alex.id } });
  }

  const groceries = await prisma.list.findFirstOrThrow({ where: { householdId: hid, type: 'GROCERY' } });
  const items: [string, string | null, string][] = [
    ['Milk', '2', 'Dairy & Eggs'], ['Eggs', '12', 'Dairy & Eggs'], ['Bananas', '6', 'Produce'], ['Spinach', '1 bag', 'Produce'],
    ['Chicken thighs', '2 lb', 'Meat & Seafood'], ['Sourdough bread', '1', 'Bakery'], ['Rice', null, 'Pantry'], ['Paper towels', null, 'Household'],
  ];
  let i = 0;
  for (const [name, quantity, category] of items) {
    await prisma.listItem.create({ data: { id: crypto.randomUUID(), householdId: hid, listId: groceries.id, name, quantity, category, sortOrder: i++, isDone: i === 3 } });
  }
  const packing = await prisma.list.create({ data: { householdId: hid, name: 'Beach trip packing', type: 'PACKING', isTemplate: true } });
  for (const name of ['Sunscreen', 'Towels', 'Swimsuits', 'Snacks', 'Water bottles']) {
    await prisma.listItem.create({ data: { id: crypto.randomUUID(), householdId: hid, listId: packing.id, name, sortOrder: i++ } });
  }

  await prisma.announcement.createMany({
    data: [
      { householdId: hid, title: 'Grandma Rosa arrives Saturday!', body: 'Guest room needs fresh sheets by Friday.', priority: 'IMPORTANT', pinned: true, authorId: owner.id },
      { householdId: hid, title: 'Library books due Thursday', priority: 'NORMAL', authorId: sam.id },
    ],
  });

  console.log(`Seeded "${household.name}". Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD} (also ${PARTNER_EMAIL}). Household PIN: 1234`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
