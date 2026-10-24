import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.js';
import { addMember, app, login, makeHousehold, resetDb } from './helpers.js';

const range = '?start=2026-01-01T00:00:00Z&end=2026-12-31T00:00:00Z';
const ev = (calendarId: string, title: string, extra: object = {}) => ({
  calendarId, title, startAt: '2026-06-01T14:00:00Z', endAt: '2026-06-01T15:00:00Z', timezone: 'America/New_York', memberIds: [], ...extra,
});

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('auth & security', () => {
  it('rejects writes without the CSRF header', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'x@y.z', password: 'whatever-123' });
    expect(res.status).toBe(403);
  });

  it('requires authentication for household data', async () => {
    const { household } = await makeHousehold();
    expect((await request(app).get(`/api/v1/households/${household.id}/calendars`)).status).toBe(401);
  });

  it('isolates households: a member of A cannot see B (404, not 403)', async () => {
    const a = await makeHousehold('A');
    const b = await makeHousehold('B');
    const s = await login(a.ownerUser.email);
    expect((await s.get(`/api/v1/households/${b.household.id}/calendars`)).status).toBe(404);
    expect((await s.get(`/api/v1/households/${b.household.id}/lists`)).status).toBe(404);
    expect((await s.get(`/api/v1/households/${a.household.id}/lists`)).status).toBe(200);
  });

  it('sets hardened security headers', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('calendar privacy', () => {
  it('hides private calendars and reduces busy-only calendars to untitled busy blocks', async () => {
    const { household, ownerUser } = await makeHousehold();
    const sam = await addMember(household.id, 'ADULT', 'Sam');
    const base = `/api/v1/households/${household.id}`;
    const samS = await login(sam.user.email);
    const priv = (await samS.post(`${base}/calendars`, { name: 'Sam private', color: '#111111', visibility: 'PRIVATE' })).body;
    const busy = (await samS.post(`${base}/calendars`, { name: 'Sam work', color: '#222222', visibility: 'BUSY_ONLY' })).body;
    expect(priv.id).toBeTruthy();
    expect((await samS.post(`${base}/events`, ev(priv.id, 'Therapy'))).status).toBe(201);
    expect((await samS.post(`${base}/events`, ev(busy.id, 'Layoff planning'))).status).toBe(201);

    const owner = await login(ownerUser.email);
    const cals = (await owner.get(`${base}/calendars`)).body as { id: string }[];
    expect(cals.map((c) => c.id)).not.toContain(priv.id);
    const events = (await owner.get(`${base}/events${range}`)).body as { title: string; busyOnly: boolean; description: unknown; location: unknown }[];
    const raw = JSON.stringify(events);
    expect(raw).not.toContain('Therapy');
    expect(raw).not.toContain('Layoff');
    const block = events.find((e) => e.busyOnly)!;
    expect(block.title).toBe('Busy');
    expect(block.location ?? null).toBeNull();
    // Sam still sees full details of their own events.
    expect(JSON.stringify((await samS.get(`${base}/events${range}`)).body)).toContain('Therapy');
  });

  it('children can read but not write family calendars; guests too', async () => {
    const { household } = await makeHousehold();
    const kid = await addMember(household.id, 'CHILD', 'Kid');
    const base = `/api/v1/households/${household.id}`;
    const k = await login(kid.user.email);
    const family = ((await k.get(`${base}/calendars`)).body as { id: string; name: string }[]).find((c) => c.name === 'Family')!;
    expect(family).toBeTruthy();
    expect((await k.post(`${base}/events`, ev(family.id, 'Party!'))).status).toBe(403);
  });

  it('blocks ICS subscriptions that point at private network addresses (SSRF)', async () => {
    const { household, ownerUser } = await makeHousehold();
    const s = await login(ownerUser.email);
    const res = await s.post(`/api/v1/households/${household.id}/calendars/subscribe`, { url: 'http://127.0.0.1:5432/x.ics', name: 'Evil', color: '#000000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('expands recurring events and enforces optimistic concurrency on edits', async () => {
    const { household, ownerUser } = await makeHousehold();
    const base = `/api/v1/households/${household.id}`;
    const s = await login(ownerUser.email);
    const family = ((await s.get(`${base}/calendars`)).body as { id: string; name: string }[]).find((c) => c.name === 'Family')!;
    const created = (await s.post(`${base}/events`, ev(family.id, 'Swim', { rrule: 'FREQ=WEEKLY;COUNT=4' }))).body;
    const occ = (await s.get(`${base}/events${range}`)).body as { title: string }[];
    expect(occ.filter((o) => o.title === 'Swim')).toHaveLength(4);
    const stale = await s.patch(`${base}/events/${created.id}`, { title: 'Swim lessons', scope: 'all', expectedVersion: created.version + 5 });
    expect(stale.status).toBe(409);
    const ok = await s.patch(`${base}/events/${created.id}`, { title: 'Swim lessons', scope: 'all', expectedVersion: created.version });
    expect(ok.status).toBe(200);
  });
});

describe('chores & rewards', () => {
  it('runs the complete → approve → redeem → approve flow with point accounting', async () => {
    const { household, ownerUser } = await makeHousehold();
    const kid = await addMember(household.id, 'CHILD', 'Kid');
    const base = `/api/v1/households/${household.id}`;
    const parent = await login(ownerUser.email);
    const k = await login(kid.user.email);
    const chore = (await parent.post(`${base}/tasks`, { kind: 'CHORE', title: 'Dishes', points: 40, requiresApproval: true, rrule: 'FREQ=DAILY', memberIds: [kid.member.id] })).body;
    expect((await k.post(`${base}/tasks`, { kind: 'CHORE', title: 'Nap', points: 1000, memberIds: [] })).status).toBe(403);

    const done = await k.post(`${base}/tasks/${chore.id}/complete`, { memberId: kid.member.id });
    expect(done.status).toBe(201);
    expect(done.body.needsApproval).toBe(true);
    expect((await k.post(`${base}/tasks/${chore.id}/complete`, { memberId: kid.member.id })).status).toBe(409);

    const balance = async () => ((await parent.get(`${base}/points`)).body as { memberId: string; balance: number; available: number }[]).find((p) => p.memberId === kid.member.id)!;
    expect((await balance()).balance).toBe(0);
    expect((await k.post(`${base}/completions/${done.body.id}/review`, { approve: true })).status).toBe(403);
    expect((await parent.post(`${base}/completions/${done.body.id}/review`, { approve: true })).status).toBe(200);
    expect((await balance()).balance).toBe(40);

    const cheap = (await parent.post(`${base}/rewards`, { title: 'Ice cream', cost: 30 })).body;
    const pricey = (await parent.post(`${base}/rewards`, { title: 'Bike', cost: 500 })).body;
    expect((await k.post(`${base}/rewards/${pricey.id}/redeem`, { memberId: kid.member.id })).status).toBe(422);
    const r = await k.post(`${base}/rewards/${cheap.id}/redeem`, { memberId: kid.member.id });
    expect(r.status).toBe(201);
    expect((await balance()).available).toBe(10);
    // Reserved points cannot be double-spent.
    expect((await k.post(`${base}/rewards/${cheap.id}/redeem`, { memberId: kid.member.id })).status).toBe(422);
    expect((await parent.post(`${base}/redemptions/${r.body.id}/review`, { approve: true })).status).toBe(200);
    expect((await balance()).balance).toBe(10);
  });
});

describe('lists', () => {
  it('adds items idempotently, categorizes groceries and detects stale edits', async () => {
    const { household, ownerUser } = await makeHousehold();
    const base = `/api/v1/households/${household.id}`;
    const s = await login(ownerUser.email);
    const grocery = ((await s.get(`${base}/lists`)).body as { id: string; type: string }[]).find((l) => l.type === 'GROCERY')!;
    const id = crypto.randomUUID();
    const a = await s.post(`${base}/lists/${grocery.id}/items`, { id, name: 'Bananas' });
    const b = await s.post(`${base}/lists/${grocery.id}/items`, { id, name: 'Bananas' });
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(id);
    expect(a.body.category).toBe('Produce');
    const items = (await s.get(`${base}/lists/${grocery.id}`)).body.items as unknown[];
    expect(items).toHaveLength(1);
    expect((await s.patch(`${base}/lists/${grocery.id}/items/${id}`, { name: 'Plantains', expectedVersion: 1 })).status).toBe(200);
    expect((await s.patch(`${base}/lists/${grocery.id}/items/${id}`, { name: 'Apples', expectedVersion: 1 })).status).toBe(409);
    expect((await s.patch(`${base}/lists/${grocery.id}/items/${id}`, { isDone: true, expectedVersion: 1 })).status).toBe(200);
    const csv = await s.get(`${base}/lists/${grocery.id}/export.csv`);
    expect(csv.text).toContain('Plantains');
  });
});
