import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDeveloperAccess } from '../src/lib/platform-access';
import { base32Decode, stepOf, totpAt } from '../src/lib/totp';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let root: TestDevice;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const post = (url: string, payload: unknown) => ctx.app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
const codeFor = (secret: string, offset = 0) => totpAt(base32Decode(secret), stepOf(ctx.clock.now) + offset);

/** The whole first sign-in: setup code → Google Authenticator → bound phone. */
async function activate(d: TestDevice, identifier: string, setupCode: string, institutionCode?: string) {
  const start = ok(await post('/v1/auth/setup/start', { identifier, setupCode, institutionCode }));
  const fin = ok(await post('/v1/auth/setup/finish', { identifier, setupCode, institutionCode, code: codeFor(start.secret) }));
  expect(fin.instantCode).toMatch(/^[0-9]{6}$/);
  const v = await d.verifyOtp(fin.challengeId, fin.instantCode);
  expect(v.json().status).toBe('bind_required');
  expect((await d.bind(v.json().ticket)).statusCode).toBe(200);
  return start.secret as string;
}

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'developer', 'Platform Root', 'root@iit.ac.in')`, [seed.tenantId]);
  root = new TestDevice(ctx);
  await root.signIn('root@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('registration with Google Authenticator (no email)', () => {
  let tenant: { id: string; code: string };
  let setupCode: string;
  const owner = new Map<string, TestDevice>();

  it('the developer creates an institution and gets its main admin’s one-time setup code', async () => {
    const t = ok(await root.call('POST', '/v1/root/tenants', { name: 'Hill View College', adminName: 'Dr. Meera Nair', adminEmail: 'principal@hillview.edu' }));
    expect(t.adminSetup).toMatchObject({ name: 'Dr. Meera Nair', signInId: 'principal@hillview.edu' });
    expect(t.adminSetup.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    tenant = { id: t.id, code: t.code };
    setupCode = t.adminSetup.code;
    // Only a hash is stored.
    const row = (await ctx.db.query<{ setup_code_hash: Buffer }>(`select setup_code_hash from users where email = 'principal@hillview.edu'`)).rows[0]!;
    expect(row.setup_code_hash.toString('utf8')).not.toContain(setupCode.replace(/-/g, ''));
    const d = ok(await root.call('GET', `/v1/root/tenants/${t.id}`));
    expect(d.admins[0]).toMatchObject({ owner: true, authenticator: false });
  });

  it('refuses before the institution is verified, and for another institution’s code', async () => {
    const r = await post('/v1/auth/setup/start', { identifier: 'principal@hillview.edu', setupCode, institutionCode: tenant.code });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toContain('verified');
    ok(await root.call('POST', `/v1/root/tenants/${tenant.id}/verify`, { verified: true }));
    expect((await post('/v1/auth/setup/start', { identifier: 'principal@hillview.edu', setupCode, institutionCode: 'DEMO2026' })).statusCode).toBe(400);
  });

  it('a wrong setup code is refused with the same message as an unknown ID', async () => {
    const wrong = await post('/v1/auth/setup/start', { identifier: 'principal@hillview.edu', setupCode: 'AAAA-AAAA-AAAA' });
    const nobody = await post('/v1/auth/setup/start', { identifier: 'nobody@hillview.edu', setupCode });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toBe(nobody.json().error.message);
  });

  it('the main admin links Google Authenticator with it and is signed in on their phone', async () => {
    const start = ok(await post('/v1/auth/setup/start', { identifier: 'Principal@HillView.edu', setupCode: setupCode.toLowerCase(), institutionCode: tenant.code }));
    expect(start).toMatchObject({ name: 'Dr. Meera Nair', institution: 'Hill View College', issuer: 'Attendly', account: 'principal@hillview.edu' });
    expect(start.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    // A wrong authenticator code doesn't use anything up.
    expect((await post('/v1/auth/setup/finish', { identifier: 'principal@hillview.edu', setupCode, code: '000000' })).statusCode).toBe(400);
    const fin = ok(await post('/v1/auth/setup/finish', { identifier: 'principal@hillview.edu', setupCode, institutionCode: tenant.code, code: codeFor(start.secret) }));
    const d = new TestDevice(ctx);
    const v = await d.verifyOtp(fin.challengeId, fin.instantCode);
    expect((await d.bind(v.json().ticket)).statusCode).toBe(200);
    const me = ok(await d.call('GET', '/v1/staff/me'));
    expect(me.user.role).toBe('admin');
    expect(me.owner).toBe(true);
    owner.set('meera', d);
    // The setup code is used up.
    expect((await post('/v1/auth/setup/start', { identifier: 'principal@hillview.edu', setupCode })).statusCode).toBe(400);
    // From now on: ID + the authenticator's code (nothing is emailed).
    ctx.clock.now += 31_000;
    const again = new TestDevice(ctx);
    const r = await again.requestOtp('principal@hillview.edu', 'email', tenant.code);
    expect(r.json().method).toBe('authenticator');
    // Nothing is sent, so asking again at once is fine (the daily wrong-code budget still applies).
    expect((await again.requestOtp('principal@hillview.edu', 'email', tenant.code)).statusCode).toBe(200);
    expect(ctx.sent.find((m) => m.to === 'principal@hillview.edu')).toBeUndefined();
    expect((await again.verifyOtp(r.json().challengeId, codeFor(start.secret))).json().status).toBe('device_mismatch');
  });

  it('five wrong guesses burn a setup code', async () => {
    const meera = owner.get('meera')!;
    const hod = ok(await meera.call('POST', '/v1/staff/people', { role: 'admin', fullName: 'Prof. HOD', email: 'hod@hillview.edu' }));
    const issued = ok(await meera.call('POST', `/v1/staff/people/${hod.id}/setup-code`, {}));
    for (let i = 0; i < 5; i++) expect((await post('/v1/auth/setup/start', { identifier: 'hod@hillview.edu', setupCode: `BBBB-BBBB-BBB${'CDEFG'[i]}` })).statusCode).toBe(400);
    expect((await post('/v1/auth/setup/start', { identifier: 'hod@hillview.edu', setupCode: issued.code })).statusCode).toBe(400);
  });

  it('the main admin adds admins; other admins add professors (with extra powers) but never admins', async () => {
    const meera = owner.get('meera')!;
    const people = ok(await meera.call('GET', '/v1/staff/people?role=staff'));
    const hodId = people.find((p: { email: string }) => p.email === 'hod@hillview.edu').id;
    const code = ok(await meera.call('POST', `/v1/staff/people/${hodId}/setup-code`, {}));
    expect(ok(await meera.call('GET', `/v1/staff/people/${hodId}`)).setupPending).toBe(true);
    const hod = new TestDevice(ctx);
    await activate(hod, 'hod@hillview.edu', code.code, tenant.code);
    expect(ok(await hod.call('GET', '/v1/staff/me')).owner).toBe(false);
    expect(ok(await meera.call('GET', `/v1/staff/people/${hodId}`))).toMatchObject({ setupPending: false, authenticator: true });

    // The other admin: no admins…
    const noAdmin = await hod.call('POST', '/v1/staff/people', { role: 'admin', fullName: 'X', email: 'x@hillview.edu' });
    expect(noAdmin.statusCode).toBe(403);
    expect(noAdmin.json().error.message).toContain('main admin');
    // …but professors, with "sudo" powers, and their setup codes.
    const prof = ok(await hod.call('POST', '/v1/staff/people', { role: 'teacher', fullName: 'Prof. Rao', email: 'rao@hillview.edu' }));
    expect(ok(await hod.call('POST', `/v1/staff/people/${prof.id}/access`, { role: 'teacher', permissions: ['people', 'planner'] })).permissions).toEqual(['people', 'planner']);
    const profCode = ok(await hod.call('POST', `/v1/staff/people/${prof.id}/setup-code`, {}));
    const rao = new TestDevice(ctx);
    await activate(rao, 'rao@hillview.edu', profCode.code, tenant.code);
    expect(ok(await rao.call('GET', '/v1/staff/me')).permissions).toEqual(expect.arrayContaining(['people', 'planner']));
    // Promotions, admin setup codes and admin accounts are the main admin's alone.
    expect((await hod.call('POST', `/v1/staff/people/${prof.id}/access`, { role: 'admin', permissions: [] })).statusCode).toBe(403);
    const meeraId = people.find((p: { email: string }) => p.email === 'principal@hillview.edu').id;
    expect((await hod.call('POST', `/v1/staff/people/${meeraId}/setup-code`, {})).statusCode).toBe(403);
    expect((await hod.call('POST', `/v1/staff/people/${meeraId}`, { status: 'suspended' })).statusCode).toBe(403);
    expect((await rao.call('POST', `/v1/staff/people/${hodId}/setup-code`, {})).statusCode).toBe(403);
    // The main admin promotes and demotes; they themselves always stay admin.
    expect(ok(await meera.call('POST', `/v1/staff/people/${prof.id}/access`, { role: 'admin', permissions: [] })).role).toBe('admin');
    expect(ok(await meera.call('POST', `/v1/staff/people/${prof.id}/access`, { role: 'teacher', permissions: [] })).role).toBe('teacher');
    expect((await meera.call('POST', `/v1/staff/people/${meeraId}/access`, { role: 'teacher', permissions: [] })).statusCode).toBe(409);
  });

  it('a new main-admin setup code from the developer: the old phone stops working', async () => {
    const issued = ok(await root.call('POST', `/v1/root/tenants/${tenant.id}/admin-setup`, {}));
    expect(issued.signInId).toBe('principal@hillview.edu');
    expect((await owner.get('meera')!.call('GET', '/v1/staff/me')).statusCode).toBe(401);
    const phone2 = new TestDevice(ctx);
    ctx.clock.now += 31_000;
    await activate(phone2, 'principal@hillview.edu', issued.code, tenant.code);
    expect(ok(await phone2.call('GET', '/v1/staff/me')).owner).toBe(true);
  });
});

describe('the developer sets up Attendly Developer once', () => {
  it('prints a setup code until Google Authenticator is linked; a reset starts over', async () => {
    const config = { ...ctx.deps.config, developer: { signInId: 'owner@platform.test', resetAuthenticator: false } };
    const lines: string[] = [];
    await ensureDeveloperAccess(ctx.db, config, ctx.deps.hash, ctx.clock.now, (m) => lines.push(m));
    expect(lines.join('\n')).toContain('created the developer account owner@platform.test');
    const code = lines.join('\n').match(/setup code ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/)![1]!;
    // A restart prints the same code (it stays valid until used).
    const again: string[] = [];
    await ensureDeveloperAccess(ctx.db, config, ctx.deps.hash, ctx.clock.now + 3_600_000, (m) => again.push(m));
    expect(again.join('\n')).toContain(`setup code ${code}`);
    const dev = new TestDevice(ctx);
    await activate(dev, 'owner@platform.test', code);
    expect(ok(await dev.call('GET', '/v1/root/me')).sandbox).toBe(false);
    // It can create institutions for real.
    ok(await dev.call('POST', '/v1/root/tenants', { name: 'Lake College', adminName: 'A', adminEmail: 'a@lake.edu' }));

    const later: string[] = [];
    await ensureDeveloperAccess(ctx.db, config, ctx.deps.hash, ctx.clock.now, (m) => later.push(m));
    expect(later.join()).toContain('sign-in ID: owner@platform.test');
    expect(later.join()).not.toContain('setup code');

    const reset: string[] = [];
    await ensureDeveloperAccess(ctx.db, { ...config, developer: { ...config.developer, resetAuthenticator: true } }, ctx.deps.hash, ctx.clock.now, (m) => reset.push(m));
    expect(reset.join('\n')).toMatch(/setup code [A-Z2-9-]{14}/);
    expect((await dev.call('GET', '/v1/root/me')).statusCode).toBe(401);
  });

  it('never turns a staff account into the developer', async () => {
    const lines: string[] = [];
    await ensureDeveloperAccess(ctx.db, { ...ctx.deps.config, developer: { signInId: 'aarav@iit.ac.in', resetAuthenticator: false } }, ctx.deps.hash, ctx.clock.now, (m) => lines.push(m));
    expect(lines.join()).toContain('not a developer');
    expect((await ctx.db.query(`select role from users where email = 'aarav@iit.ac.in'`)).rows[0]!.role).toBe('student');
  });
});
