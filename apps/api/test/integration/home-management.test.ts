import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { hashSecret } from '../../src/auth/passwords.js';
import { randomToken, sha256 } from '../../src/lib/crypto.js';
import { emailAdapter } from '../../src/lib/email.js';
import { addMember, app, login, makeHousehold, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());
const base = (id: string) => `/api/v1/households/${id}`;

async function invitation(householdId: string, invitedById: string, email: string, extra: object = {}) {
  const token = randomToken(32);
  const inv = await prisma.invitation.create({ data: { householdId, invitedById, email, role: 'ADULT', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86400000), ...extra } });
  return { inv, token };
}

async function display(householdId: string) {
  await prisma.household.update({ where: { id: householdId }, data: { pinHash: await hashSecret('4321') } });
  const device = await prisma.device.create({ data: { householdId, name: 'Kitchen', pairedAt: new Date() } });
  const token = randomToken(32);
  await prisma.session.create({ data: { tokenHash: sha256(token), deviceId: device.id, householdId, expiresAt: new Date(Date.now() + 86400000) } });
  const cookie = `fh_session=${token}; fh_csrf=c`;
  return {
    device,
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    del: (url: string) => request(app).delete(url).set('Cookie', cookie).set('x-csrf-token', 'c'),
    unlock: () => request(app).post(`${base(householdId)}/pin/verify`).set('Cookie', cookie).set('x-csrf-token', 'c').send({ pin: '4321' }),
  };
}

describe('multiple homes and existing-account invitations', () => {
  it('returns every active, unexpired home and isolates unrelated homes', async () => {
    const a = await makeHousehold('Manmay');
    const b = await makeHousehold('1108');
    const c = await makeHousehold('Private');
    const d = await makeHousehold('Expired');
    await prisma.householdMember.createMany({ data: [
      { householdId: b.household.id, userId: a.ownerUser.id, firstName: 'Owner', displayName: 'Owner', role: 'ADULT', color: '#123456' },
      { householdId: d.household.id, userId: a.ownerUser.id, firstName: 'Owner', displayName: 'Owner', role: 'GUEST', color: '#123456', accessExpiresAt: new Date(0) },
    ] });
    const s = await login(a.ownerUser.email);
    const me = await s.get('/api/v1/auth/me');
    expect(me.body.memberships.map((m: { householdName: string }) => m.householdName)).toEqual(expect.arrayContaining(['Manmay', '1108']));
    expect(me.body.memberships).toHaveLength(2);
    expect((await s.get(base(b.household.id))).body.name).toBe('1108');
    expect((await s.get(base(c.household.id))).status).toBe(404);
  });

  it('lists only my valid invitations and joining still requires both confirmations', async () => {
    const a = await makeHousehold('My home');
    const b = await makeHousehold('Invited home');
    const valid = await invitation(b.household.id, b.ownerUser.id, a.ownerUser.email);
    await invitation(b.household.id, b.ownerUser.id, a.ownerUser.email, { revokedAt: new Date() });
    await invitation(b.household.id, b.ownerUser.id, a.ownerUser.email, { expiresAt: new Date(0) });
    const other = await invitation(b.household.id, b.ownerUser.id, 'somebody@test.local');
    const s = await login(a.ownerUser.email);
    const list = await s.get('/api/v1/me/invitations');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ id: valid.inv.id, householdName: 'Invited home' })]);
    expect(list.body[0]).not.toHaveProperty('tokenHash');
    expect((await s.post('/api/v1/invitations/accept', { invitationId: other.inv.id })).status).toBe(403);
    const accepted = await s.post('/api/v1/invitations/accept', { invitationId: valid.inv.id });
    expect(accepted.status).toBe(201);
    expect(accepted.body.joinRequest.status).toBe('pending');
    expect((await s.get(base(b.household.id))).status).toBe(404);
    const outbox = (emailAdapter as unknown as { outbox: { to: string; subject: string; text: string }[] }).outbox;
    const code = (email: string, subject: string) => [...outbox].reverse().find((m) => m.to === email && m.subject.includes(subject))!.text.match(/code: (\d{6})/)![1];
    const id = accepted.body.joinRequest.id as string;
    expect((await s.post(`/api/v1/join-requests/${id}/verify`, { code: code(a.ownerUser.email, 'Your code to join') })).status).toBe(200);
    expect((await s.get(base(b.household.id))).status).toBe(404);
    const admin = await login(b.ownerUser.email);
    expect((await admin.post(`${base(b.household.id)}/join-requests/${id}/approve`, { code: code(b.ownerUser.email, 'Approve') })).body.status).toBe('approved');
    expect((await s.get('/api/v1/auth/me')).body.memberships).toHaveLength(2);
  });

  it('opens an already-joined invited home instead of returning a conflict or creating another member', async () => {
    const a = await makeHousehold('1108');
    const s = await login(a.ownerUser.email);
    const { inv, token } = await invitation(a.household.id, a.ownerUser.id, a.ownerUser.email, { acceptedAt: new Date() });
    const res = await s.post('/api/v1/invitations/accept', { token });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ alreadyMember: true, householdId: a.household.id, householdName: '1108' });
    expect(await prisma.householdMember.count({ where: { householdId: a.household.id, userId: a.ownerUser.id } })).toBe(1);
    expect((await s.post(`${base(a.household.id)}/invitations`, { email: a.ownerUser.email, role: 'ADULT' })).body.error.message).toContain('already a member');
    await prisma.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
    expect((await s.post('/api/v1/invitations/accept', { token })).status).toBe(404);
  });
});

describe('safe member removal and device overview', () => {
  it('requires the device PIN and revokes only the selected home, preserving history', async () => {
    const a = await makeHousehold();
    const b = await makeHousehold('Other home');
    const member = await addMember(a.household.id, 'ADULT', 'Alex');
    await prisma.householdMember.create({ data: { householdId: b.household.id, userId: member.user.id, firstName: 'Alex', displayName: 'Alex', role: 'ADULT', color: '#123456' } });
    const push = await prisma.pushSubscription.create({ data: { householdId: a.household.id, memberId: member.member.id, kind: 'FCM', endpoint: 'alex-token' } });
    const inv = await invitation(a.household.id, a.ownerUser.id, member.user.email);
    const pending = await prisma.joinRequest.create({ data: { householdId: a.household.id, userId: member.user.id, invitationId: inv.inv.id, role: 'ADULT', expiresAt: new Date(Date.now() + 86400000) } });
    const actor = await display(a.household.id);
    const path = `${base(a.household.id)}/members/${member.member.id}`;
    const memberSession = await login(member.user.email);
    expect((await actor.del(path)).status).toBe(403);
    expect((await actor.unlock()).status).toBe(200);
    expect((await actor.del(path)).status).toBe(204);
    expect((await prisma.householdMember.findUniqueOrThrow({ where: { id: member.member.id } })).isActive).toBe(false);
    expect(await prisma.pushSubscription.findUnique({ where: { id: push.id } })).toBeNull();
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.inv.id } })).revokedAt).not.toBeNull();
    expect((await prisma.joinRequest.findUniqueOrThrow({ where: { id: pending.id } })).rejectedAt).not.toBeNull();
    expect((await memberSession.get(base(a.household.id))).status).toBe(404);
    expect((await memberSession.get(base(b.household.id))).status).toBe(200);
    expect((await memberSession.get('/api/v1/auth/me')).body.memberships).toHaveLength(1);
    expect((await actor.get(`${base(a.household.id)}/members`)).body.some((m: { id: string }) => m.id === member.member.id)).toBe(false);
    await vi.waitFor(async () => expect(await prisma.notification.count({ where: { householdId: a.household.id, type: 'member.removed' } })).toBeGreaterThan(0));
  });

  it('protects owners/admins, forbids cross-home removal and blocks the PATCH deactivation shortcut', async () => {
    const a = await makeHousehold();
    const other = await makeHousehold();
    const admin = await addMember(a.household.id, 'ADULT_ADMIN', 'Parent');
    const child = await addMember(a.household.id, 'CHILD', 'Child');
    const actor = await display(a.household.id);
    await actor.unlock();
    expect((await actor.del(`${base(a.household.id)}/members/${a.ownerMember.id}`)).status).toBe(409);
    expect((await actor.del(`${base(a.household.id)}/members/${admin.member.id}`)).status).toBe(403);
    expect((await actor.del(`${base(a.household.id)}/members/${other.ownerMember.id}`)).status).toBe(404);
    const s = await login(child.user.email);
    expect((await s.del(`${base(a.household.id)}/members/${admin.member.id}`)).status).toBe(403);
    const owner = await login(a.ownerUser.email);
    expect((await owner.patch(`${base(a.household.id)}/members/${a.ownerMember.id}`, { isActive: false })).status).toBe(409);
    await prisma.session.updateMany({ where: { deviceId: actor.device.id }, data: { pinElevatedUntil: new Date(0) } });
    expect((await actor.del(`${base(a.household.id)}/members/${child.member.id}`)).status).toBe(403);
  });

  it('allows a scoped device roster without pairing secrets and keeps management owner-only', async () => {
    const a = await makeHousehold();
    const b = await makeHousehold();
    const adult = await addMember(a.household.id, 'ADULT', 'Adult');
    const actor = await display(a.household.id);
    await prisma.device.create({ data: { householdId: b.household.id, name: 'Private display' } });
    const s = await login(adult.user.email);
    const roster = await s.get(`${base(a.household.id)}/devices`);
    expect(roster.status).toBe(200);
    expect(roster.body).toHaveLength(1);
    expect(roster.body[0]).not.toHaveProperty('pairingCodeHash');
    expect((await actor.get(`${base(b.household.id)}/devices`)).status).toBe(404);
    expect((await s.del(`${base(a.household.id)}/devices/${actor.device.id}`)).status).toBe(403);
    const owner = await login(a.ownerUser.email);
    expect((await owner.del(`${base(a.household.id)}/devices/${actor.device.id}`)).status).toBe(204);
    expect((await actor.get(`${base(a.household.id)}/devices`)).status).toBe(401);
  });
});
