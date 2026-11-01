import request from 'supertest';
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.ALEXA_CLIENT_ID = 'alexa-client';
  process.env.ALEXA_CLIENT_SECRET = 'alexa-secret';
  process.env.ALEXA_TEST_SKIP_VERIFY = '1';
});

import { prisma } from '../../src/db.js';
import { normalizeCertUrl, timestampFresh } from '../../src/lib/alexaVerify.js';
import { validAlexaRedirect } from '../../src/routes/alexa.js';
import { addMember, app, login, makeHousehold, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const REDIRECT = 'https://pitangui.amazon.com/api/skill/link/M2AAAAAAAAAAAA';
const basic = 'Basic ' + Buffer.from('alexa-client:alexa-secret').toString('base64');
const intent = (token: string | undefined, name: string, slots: Record<string, string> = {}) => ({
  version: '1.0',
  context: { System: { user: token ? { accessToken: token } : {}, application: { applicationId: 'amzn1.ask.skill.x' } } },
  request: { type: 'IntentRequest', timestamp: new Date().toISOString(), intent: { name, slots: Object.fromEntries(Object.entries(slots).map(([k, value]) => [k, { name: k, value }])) } },
});
const skill = (body: object) => request(app).post('/api/v1/alexa/skill').set('Content-Type', 'application/json').send(JSON.stringify(body));

async function link(email: string, householdId: string, verifier?: string) {
  const s = await login(email);
  const auth = await s.post('/api/v1/alexa/authorize', {
    clientId: 'alexa-client', redirectUri: REDIRECT, state: 'st8', householdId,
    ...(verifier ? { codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' } : {}),
  });
  expect(auth.status).toBe(200);
  const to = new URL(auth.body.redirectTo);
  expect(to.origin + to.pathname).toBe(REDIRECT);
  expect(to.searchParams.get('state')).toBe('st8');
  return { s, code: to.searchParams.get('code')! };
}

const token = (form: Record<string, string>, auth = basic) => request(app).post('/api/v1/alexa/token').set('Authorization', auth).type('form').send(form);

describe('Alexa account linking and skill', () => {
  it('links a member to one home with PKCE, refreshes tokens, and runs voice intents in that home', async () => {
    const { household, ownerUser } = await makeHousehold('Manmay');
    const kid = await addMember(household.id, 'CHILD', 'Leo');
    await prisma.rewardTransaction.create({ data: { householdId: household.id, memberId: kid.member.id, type: 'EARN', status: 'APPROVED', points: 15, note: 'Dishes' } });
    const { code } = await link(ownerUser.email, household.id, 'v'.repeat(50));

    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'x'.repeat(50) })).status).toBe(400);
    const t = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'v'.repeat(50) });
    // the failed PKCE attempt does not burn the code; a second redemption does
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'v'.repeat(50) })).body.error).toBe('invalid_grant');
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token }, 'Basic ' + Buffer.from('alexa-client:wrong').toString('base64'))).status).toBe(401);

    const add = await skill(intent(t.body.access_token, 'AddToListIntent', { item: 'milk, eggs and bread', list: 'grocery' }));
    const grocery = await prisma.list.findFirstOrThrow({ where: { householdId: household.id, type: 'GROCERY' }, orderBy: { createdAt: 'asc' } });
    expect(add.body.response.outputSpeech.text).toBe(`Added milk, eggs and bread to ${grocery.name}.`);
    expect(await prisma.listItem.findMany({ where: { listId: grocery.id }, select: { name: true } })).toEqual(expect.arrayContaining([{ name: 'milk' }, { name: 'eggs' }, { name: 'bread' }]));
    const task = await skill(intent(t.body.access_token, 'AddTaskIntent', { task: 'call the plumber' }));
    expect(task.body.response.outputSpeech.text).toBe('Added the task call the plumber.');
    expect(await prisma.task.count({ where: { householdId: household.id, title: 'call the plumber' } })).toBe(1);
    expect((await skill(intent(t.body.access_token, 'PointsIntent'))).body.response.outputSpeech.text).toContain('Leo has 15 points');
    expect((await skill(intent(t.body.access_token, 'SummaryIntent'))).body.response.outputSpeech.text).toMatch(/Here is today's summary/);
    expect((await skill(intent(t.body.access_token, 'AgendaIntent'))).body.response.outputSpeech.text).toBe('Nothing is on the calendar for today.');

    const r = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token });
    expect(r.status).toBe(200);
    expect((await skill(intent(t.body.access_token, 'PointsIntent'))).body.response.card?.type).toBe('LinkAccount');
    expect((await skill(intent(r.body.access_token, 'PointsIntent'))).body.response.card).toBeUndefined();
  });

  it('respects member capabilities, removal from the home, unlinking and bad requests', async () => {
    const { household, ownerUser } = await makeHousehold();
    const kid = await addMember(household.id, 'CHILD', 'Mia');
    const { code } = await link(kid.user.email, household.id);
    const t = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    expect((await skill(intent(t.body.access_token, 'AddTaskIntent', { task: 'buy a pony' }))).body.response.outputSpeech.text).toBe('Only parents can add tasks from Alexa.');
    expect(await prisma.task.count({ where: { title: 'buy a pony' } })).toBe(0);

    const owner = await login(ownerUser.email);
    const other = await makeHousehold('Other');
    expect((await owner.post('/api/v1/alexa/authorize', { clientId: 'alexa-client', redirectUri: REDIRECT, state: 's', householdId: other.household.id })).status).toBe(404);
    expect((await owner.post('/api/v1/alexa/authorize', { clientId: 'alexa-client', redirectUri: 'https://evil.example/api/skill/link/x', state: 's', householdId: household.id })).status).toBe(400);
    expect((await owner.post('/api/v1/alexa/authorize', { clientId: 'nope', redirectUri: REDIRECT, state: 's', householdId: household.id })).status).toBe(400);

    const kidSession = await login(kid.user.email);
    const links = await kidSession.get(`/api/v1/households/${household.id}/alexa`);
    expect(links.body.links).toHaveLength(1);
    expect((await owner.del(`/api/v1/households/${household.id}/alexa/${links.body.links[0].id}`)).status).toBe(404);
    expect((await kidSession.del(`/api/v1/households/${household.id}/alexa/${links.body.links[0].id}`)).status).toBe(200);
    expect((await skill(intent(t.body.access_token, 'PointsIntent'))).body.response.card.type).toBe('LinkAccount');

    const { code: code2 } = await link(kid.user.email, household.id);
    const t2 = await token({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT });
    await prisma.householdMember.update({ where: { id: kid.member.id }, data: { isActive: false } });
    expect((await skill(intent(t2.body.access_token, 'PointsIntent'))).body.response.card.type).toBe('LinkAccount');
    expect((await token({ grant_type: 'refresh_token', refresh_token: t2.body.refresh_token })).status).toBe(400);
    expect((await skill(intent(undefined, 'PointsIntent'))).body.response.card.type).toBe('LinkAccount');
    expect((await request(app).post('/api/v1/alexa/skill').set('Content-Type', 'application/json').send('{bad')).status).toBe(400);
  });

  it('validates Alexa certificate URLs, timestamps and redirect hosts', () => {
    expect(normalizeCertUrl('https://s3.amazonaws.com/echo.api/echo-api-cert.pem')).toBe('https://s3.amazonaws.com/echo.api/echo-api-cert.pem');
    expect(normalizeCertUrl('https://s3.amazonaws.com:443/echo.api/../echo.api/echo-api-cert.pem')).toBe('https://s3.amazonaws.com/echo.api/echo-api-cert.pem');
    for (const bad of ['http://s3.amazonaws.com/echo.api/c.pem', 'https://notamazon.com/echo.api/c.pem', 'https://s3.amazonaws.com/EcHo.aPi/c.pem', 'https://s3.amazonaws.com:563/echo.api/c.pem', 'https://s3.amazonaws.com/invalid.path/c.pem']) expect(normalizeCertUrl(bad)).toBeNull();
    expect(timestampFresh(new Date().toISOString())).toBe(true);
    expect(timestampFresh(new Date(Date.now() - 200_000).toISOString())).toBe(false);
    expect(validAlexaRedirect(REDIRECT)).toBe(true);
    expect(validAlexaRedirect('https://layla.amazon.com/api/skill/link/X')).toBe(true);
    expect(validAlexaRedirect('https://pitangui.amazon.com.evil.io/api/skill/link/X')).toBe(false);
  });
});
