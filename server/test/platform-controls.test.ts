import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindProofString, signB64 } from '@attendly/protocol';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let root: TestDevice;
let admin: TestDevice;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const flip = (key: string, enabled: boolean) => root.call('POST', `/v1/root/switches/${key}`, { enabled, reason: 'test', confirm: key });
let n = 0;
async function person(role: 'student' | 'teacher', hardwareId?: string) {
  const email = `p${++n}@iit.ac.in`;
  const id = (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, $2, $3, $3) returning id`, [seed.tenantId, role, email])).rows[0]!.id;
  return { id, email, phone: new TestDevice(ctx, hardwareId ? { hardwareId } : {}) };
}
async function tryBind(d: TestDevice, email: string) {
  ctx.clock.now += 31_000;
  const r = await d.requestOtp(email);
  const v = await d.verifyOtp(r.json().challengeId, d.lastCode(email));
  return d.bind(v.json().ticket);
}

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'developer', 'Root', 'root@iit.ac.in')`, [seed.tenantId]);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email, is_owner) values ($1, 'admin', 'HOD', 'hod@iit.ac.in', true)`, [seed.tenantId]);
  root = new TestDevice(ctx, { hardwareId: 'root-phone' });
  admin = new TestDevice(ctx, { hardwareId: 'hod-phone' });
  await root.signIn('root@iit.ac.in');
  await admin.signIn('hod@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('one phone, one account', () => {
  it('a phone bound to a student can’t also hold a professor’s account (or another student’s)', async () => {
    const s = await person('student', 'shared-phone');
    expect((await tryBind(s.phone, s.email)).statusCode).toBe(200);
    const t = await person('teacher', 'shared-phone');
    const r = await tryBind(t.phone, t.email);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toContain('One phone, one account');
    const s2 = await person('student', 'shared-phone');
    expect((await tryBind(s2.phone, s2.email)).json().error.message).toContain('One phone, one student');
  });

  it('two professors can’t share one phone either', async () => {
    const a = await person('teacher', 'staff-phone');
    const b = await person('teacher', 'staff-phone');
    expect((await tryBind(a.phone, a.email)).statusCode).toBe(200);
    expect((await tryBind(b.phone, b.email)).statusCode).toBe(409);
  });

  it('the developer’s own phone may also hold an institution account (testing)', async () => {
    const t = await person('teacher', 'root-phone');
    expect((await tryBind(t.phone, t.email)).statusCode).toBe(200);
  });
});

describe('kill switches, all enforced', () => {
  it('“Reject new phone bindings” also stops an approved phone change', async () => {
    const s = await person('student', 'old-phone');
    expect((await tryBind(s.phone, s.email)).statusCode).toBe(200);
    // A new phone: the student asks for the switch.
    const next = new TestDevice(ctx, { hardwareId: 'new-phone' });
    ctx.clock.now += 31_000;
    const r = await next.requestOtp(s.email);
    const v = (await next.verifyOtp(r.json().challengeId, next.lastCode(s.email))).json();
    expect(v.status).toBe('device_mismatch');
    const proof = signB64(bindProofString({ ticket: v.ticket, publicKeyB64: next.publicKeyB64, purpose: 'rebind' }), next.keys.secretKey);
    const reqId = ok(await ctx.app.inject({ method: 'POST', url: '/v1/devices/rebind-request', payload: { ticket: v.ticket, proof, reason: 'new phone' } })).requestId;
    ok(await flip('new_bindings_blocked', true));
    const refused = await admin.call('POST', `/v1/staff/device-requests/${reqId}`, { decision: 'approve' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('paused');
    ok(await flip('new_bindings_blocked', false));
    expect((await admin.call('POST', `/v1/staff/device-requests/${reqId}`, { decision: 'approve' })).statusCode).toBe(200);
  });

  it('“Pause sign-ins” also stops first sign-ins with a setup code', async () => {
    const t = await person('teacher');
    const hod = (await ctx.db.query<{ id: string }>(`select id from users where email = 'hod@iit.ac.in'`)).rows[0]!.id;
    void hod;
    const code = ok(await admin.call('POST', `/v1/staff/people/${t.id}/setup-code`, {})).code;
    ok(await flip('sign_ins_paused', true));
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/auth/setup/start', payload: { identifier: t.email, setupCode: code } });
    expect(r.statusCode).toBe(403);
    ok(await flip('sign_ins_paused', false));
  });

  it('“Testing: phone rules off” — shared phones and instant phone switches; strict again when off', async () => {
    const a = await person('student', 'test-phone');
    const b = await person('teacher', 'test-phone');
    expect((await tryBind(a.phone, a.email)).statusCode).toBe(200);
    expect((await tryBind(b.phone, b.email)).statusCode).toBe(409);
    ok(await flip('phone_rules_off', true));
    expect((await tryBind(b.phone, b.email)).statusCode).toBe(200); // one phone, two accounts
    // The same app key used for another account: the earlier holder is signed out, not refused.
    const c = await person('student');
    expect((await tryBind(b.phone, c.email)).statusCode).toBe(200);
    // A new phone takes over without an admin's approval.
    const other = new TestDevice(ctx, { hardwareId: 'new-phone' });
    ctx.clock.now += 31_000;
    const r = await other.requestOtp(a.email);
    const v = await other.verifyOtp(r.json().challengeId, other.lastCode(a.email));
    expect(v.json().status).toBe('bind_required');
    expect((await other.bind(v.json().ticket)).statusCode).toBe(200);
    expect((await ctx.db.query(`select 1 from audit_log where action = 'device.testing_handover'`)).rowCount).toBe(1);
    expect((await ctx.db.query(`select 1 from audit_log where action = 'device.testing_takeover'`)).rowCount).toBe(1);
    ok(await flip('phone_rules_off', false));
    const d = await person('teacher', 'new-phone');
    expect((await tryBind(d.phone, d.email)).statusCode).toBe(409);
    const listed = ok(await root.call('GET', '/v1/root/console')).switches.map((s: { key: string }) => s.key);
    expect(listed).toContain('phone_rules_off');
  });

  it('“Pause phone notifications” is a real, listed switch', async () => {
    const c = ok(await root.call('GET', '/v1/root/console'));
    expect(c.switches.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['notifications_paused', 'scans_paused', 'sign_ins_paused', 'new_bindings_blocked', 'hardware_checks_relaxed', 'demo_login_off']));
    ok(await flip('notifications_paused', true));
    expect((await ctx.db.query(`select enabled from system_flags where key = 'notifications_paused'`)).rows[0]!.enabled).toBe(true);
    ok(await flip('notifications_paused', false));
  });

  it('“Sign everyone out” ends every login except developers’, with a typed confirmation', async () => {
    expect((await root.call('POST', '/v1/root/sign-out-everyone', { confirm: 'yes', reason: 'incident' })).statusCode).toBe(400);
    const done = ok(await root.call('POST', '/v1/root/sign-out-everyone', { confirm: 'sign-out-everyone', reason: 'suspected leak', tenantId: seed.tenantId }));
    expect(done.signedOut).toBeGreaterThan(0);
    expect((await admin.call('GET', '/v1/staff/me')).statusCode).toBe(401);
    expect((await root.call('GET', '/v1/root/console')).statusCode).toBe(200);
    expect((await ctx.db.query(`select 1 from audit_log where action = 'root.sign_out_everyone'`)).rowCount).toBe(1);
  });
});
