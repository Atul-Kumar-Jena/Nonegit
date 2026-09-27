import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/seed';
import { createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';
import { verifyAuditChain } from '../src/lib/audit';

let ctx: TestCtx;
let seed: Seeded;
let root: TestDevice; // real developer of the IIT tenant
let sandbox: TestDevice; // root@demo.attendly.app
let admin: TestDevice;
let aarav: TestDevice;
let demoTenant: string;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};

beforeAll(async () => {
  ctx = await createTestApp({ DEMO_INSTANT_LOGIN: 'true' });
  await seedDemo(ctx.db, ctx.deps.config, { log: () => undefined });
  seed = await ctx.db.query<{ id: string }>(`update users set phone = null where email like '%@demo.attendly.app'`).then(() => seedBasic(ctx.db));
  demoTenant = (await ctx.db.query<{ id: string }>(`select id from tenants where slug = 'demo'`)).rows[0]!.id;
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'developer', 'Platform Root', 'root@iit.ac.in')`, [seed.tenantId]);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'admin', 'HOD', 'hod@iit.ac.in')`, [seed.tenantId]);
  root = new TestDevice(ctx);
  sandbox = new TestDevice(ctx);
  admin = new TestDevice(ctx);
  aarav = new TestDevice(ctx);
  await root.signIn('root@iit.ac.in');
  const r = await sandbox.requestOtp('root@demo.attendly.app');
  const v = await sandbox.verifyOtp(r.json().challengeId, r.json().instantCode);
  await sandbox.bind(v.json().ticket);
  await admin.signIn('hod@iit.ac.in');
  await aarav.signIn('aarav@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('developer console', () => {
  it('is for developers only', async () => {
    expect((await admin.call('GET', '/v1/root/console')).statusCode).toBe(403);
    expect((await aarav.call('GET', '/v1/root/tenants')).statusCode).toBe(403);
    const c = ok(await root.call('GET', '/v1/root/console'));
    expect(c.sandbox).toBe(false);
    expect(c.counts.tenants).toBeGreaterThanOrEqual(3);
    expect(c.health.db).toBe(true);
    expect(c.switches.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['scans_paused', 'sign_ins_paused', 'new_bindings_blocked', 'demo_login_off']));
  });

  it('a demo (sandbox) developer sees only the demo institute and can’t flip platform switches', async () => {
    const c = ok(await sandbox.call('GET', '/v1/root/console'));
    expect(c.sandbox).toBe(true);
    expect(c.counts.tenants).toBe(1);
    const tenants = ok(await sandbox.call('GET', '/v1/root/tenants'));
    expect(tenants.map((t: { id: string }) => t.id)).toEqual([demoTenant]);
    expect((await sandbox.call('GET', `/v1/root/tenants/${seed.tenantId}`)).statusCode).toBe(404);
    expect((await sandbox.call('POST', '/v1/root/switches/scans_paused', { enabled: true, reason: 'try', confirm: 'scans_paused' })).statusCode).toBe(403);
    expect((await sandbox.call('POST', '/v1/root/tenants', { name: 'Evil U', adminName: 'X', adminEmail: 'x@evil.edu' })).statusCode).toBe(403);
    expect((await sandbox.call('POST', `/v1/root/tenants/${seed.tenantId}/status`, { status: 'suspended', reason: 'nope', confirm: 'iit' })).statusCode).toBe(404);
    expect((await sandbox.call('POST', '/v1/root/flags', { tenantId: seed.tenantId, key: 'strict_geo', enabled: true })).statusCode).toBe(404);
    const audit = ok(await sandbox.call('GET', '/v1/root/audit'));
    expect(audit.entries.every((e: { tenant: string | null }) => e.tenant === 'Demo Institute of Technology')).toBe(true);
  });

  it('kill switches need a typed confirmation and a reason, and are enforced', async () => {
    expect((await root.call('POST', '/v1/root/switches/sign_ins_paused', { enabled: true, reason: 'maintenance', confirm: 'wrong' })).statusCode).toBe(400);
    ok(await root.call('POST', '/v1/root/switches/sign_ins_paused', { enabled: true, reason: 'maintenance', confirm: 'sign_ins_paused' }));
    const blocked = await new TestDevice(ctx).requestOtp('priya@iit.ac.in');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toContain('paused');
    // Developers can still get in to turn it off.
    ctx.clock.now += 31_000;
    expect((await new TestDevice(ctx).requestOtp('root@iit.ac.in')).statusCode).toBe(200);
    ok(await root.call('POST', '/v1/root/switches/sign_ins_paused', { enabled: false, reason: 'done', confirm: 'sign_ins_paused' }));

    ok(await root.call('POST', '/v1/root/switches/demo_login_off', { enabled: true, reason: 'demo over', confirm: 'demo_login_off' }));
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/meta' })).json().demo).toBeNull();
    expect((await new TestDevice(ctx).requestOtp('rohan@demo.attendly.app')).json().instantCode).toBeUndefined();
    ok(await root.call('POST', '/v1/root/switches/demo_login_off', { enabled: false, reason: 'demo again', confirm: 'demo_login_off' }));

    ok(await root.call('POST', '/v1/root/switches/new_bindings_blocked', { enabled: true, reason: 'incident', confirm: 'new_bindings_blocked' }));
    const d = new TestDevice(ctx);
    const r = await d.requestOtp('priya@iit.ac.in');
    const v = await d.verifyOtp(r.json().challengeId, d.lastCode('priya@iit.ac.in'));
    expect((await d.bind(v.json().ticket)).statusCode).toBe(403);
    ok(await root.call('POST', '/v1/root/switches/new_bindings_blocked', { enabled: false, reason: 'resolved', confirm: 'new_bindings_blocked' }));
  });

  it('onboards a new institution with its first admin, who can then sign in', async () => {
    const t = ok(await root.call('POST', '/v1/root/tenants', { name: 'Green Valley College', adminName: 'Dr. Anita Rao', adminEmail: 'anita@greenvalley.edu', timezone: 'Asia/Kolkata' }));
    expect(t).toMatchObject({ name: 'Green Valley College', slug: 'green-valley-college', status: 'active', admins: 1 });
    expect((await root.call('POST', '/v1/root/tenants', { name: 'Dup', adminName: 'A', adminEmail: 'anita@greenvalley.edu' })).statusCode).toBe(409);
    expect((await root.call('POST', '/v1/root/tenants', { name: 'Bad TZ', adminName: 'A', adminEmail: 'a@b.edu', timezone: 'Mars/Base' })).statusCode).toBe(400);
    expect(t.verified).toBe(false);
    expect(t.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const anita = new TestDevice(ctx);
    // Not verified yet: the Institute app shows the institution as pending, and no code is sent.
    expect(ok(await ctx.app.inject({ method: 'GET', url: `/v1/institutions/lookup?code=${t.code.slice(0, 4)}-${t.code.slice(4).toLowerCase()}` }))).toEqual({
      code: t.code,
      name: 'Green Valley College',
      verified: false,
      active: true,
    });
    await expect(anita.signIn('anita@greenvalley.edu', t.code)).rejects.toThrow(/no OTP sent/);
    // A sandbox developer can't verify institutions it can't see; the real developer verifies it.
    expect((await sandbox.call('POST', `/v1/root/tenants/${t.id}/verify`, { verified: true })).statusCode).toBe(404);
    expect(ok(await root.call('POST', `/v1/root/tenants/${t.id}/verify`, { verified: true })).verified).toBe(true);
    // The code must be this institution's: another institution's code sends nothing.
    ctx.clock.now += 31_000;
    await expect(anita.signIn('anita@greenvalley.edu', 'DEMO2026')).rejects.toThrow(/no OTP sent/);
    ctx.clock.now += 31_000;
    await anita.signIn('anita@greenvalley.edu', t.code);
    expect(ok(await anita.call('GET', '/v1/staff/me')).user.role).toBe('admin');
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/institutions/lookup?code=ZZZZZZZZ' })).statusCode).toBe(404);
    // A new code replaces the old one.
    const renewed = ok(await root.call('POST', `/v1/root/tenants/${t.id}/code`, {}));
    expect(renewed.code).not.toBe(t.code);

    // Suspend (typed slug) → everyone there is signed out; resume brings it back.
    expect((await root.call('POST', `/v1/root/tenants/${t.id}/status`, { status: 'suspended', reason: 'unpaid invoice', confirm: 'nope' })).statusCode).toBe(400);
    expect(ok(await root.call('POST', `/v1/root/tenants/${t.id}/status`, { status: 'suspended', reason: 'unpaid invoice', confirm: 'green-valley-college' })).status).toBe('suspended');
    expect((await anita.call('GET', '/v1/staff/me')).statusCode).toBe(401);
    ok(await root.call('POST', `/v1/root/tenants/${t.id}/status`, { status: 'active', reason: 'paid', confirm: 'green-valley-college' }));
    // …but never your own institution.
    expect((await root.call('POST', `/v1/root/tenants/${seed.tenantId}/status`, { status: 'suspended', reason: 'oops', confirm: 'iit' })).statusCode).toBe(409);
  });

  it('feature flags are per institution and enforced', async () => {
    const f = ok(await root.call('GET', '/v1/root/flags'));
    expect(f.definitions.map((d: { key: string }) => d.key)).toEqual(['strict_geo', 'student_requests', 'hardware_binding', 'offline_scans_off', 'manual_registers']);
    expect(f.tenants.find((t: { id: string }) => t.id === seed.tenantId).flags).toEqual({ strict_geo: false, student_requests: true, hardware_binding: false, offline_scans_off: false, manual_registers: true });
    ok(await root.call('POST', '/v1/root/flags', { tenantId: seed.tenantId, key: 'student_requests', enabled: false }));
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled', startedAt: ctx.clock.now + 2 * 86_400_000 });
    const r = await aarav.call('POST', '/v1/me/requests', { sessionId: s.id, topic: 'extra', note: 'Extra class please' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toContain('turned off');
    // The sandbox developer can use flags on the demo institute.
    ok(await sandbox.call('POST', '/v1/root/flags', { tenantId: demoTenant, key: 'strict_geo', enabled: true }));
  });

  it('audit log: filters, paging and chain verification', async () => {
    const page = ok(await root.call('GET', '/v1/root/audit?limit=5'));
    expect(page.entries).toHaveLength(5);
    expect(page.nextBefore).toBe(page.entries[4].id);
    const next = ok(await root.call('GET', `/v1/root/audit?limit=5&before=${page.nextBefore}`));
    expect(next.entries[0].id).toBeLessThan(page.nextBefore);
    const auth = ok(await root.call('GET', '/v1/root/audit?category=auth'));
    expect(auth.entries.length).toBeGreaterThan(0);
    expect(auth.entries.every((e: { category: string }) => e.category === 'auth')).toBe(true);
    const adminCat = ok(await root.call('GET', '/v1/root/audit?category=admin'));
    expect(adminCat.entries.some((e: { action: string }) => e.action === 'root.switch')).toBe(true);
    expect(adminCat.entries.every((e: { category: string }) => e.category === 'admin')).toBe(true);
    const v = ok(await root.call('POST', '/v1/root/audit/verify'));
    expect(v.ok).toBe(true);
    expect((await verifyAuditChain(ctx.db)).ok).toBe(true);
    const me = ok(await root.call('GET', '/v1/root/me'));
    expect(me).toMatchObject({ sandbox: false, user: { email: 'root@iit.ac.in' }, environment: { demoMode: true } });
  });
});
