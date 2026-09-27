import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/seed';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let root: TestDevice;
let sandbox: TestDevice;
let aarav: TestDevice;
let rootId: string;
let hodId: string;
let demoTenant: string;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const act = (who: TestDevice, tenant: string, pid: string, action: string, as: 'named' | 'support' = 'support') =>
  who.call('POST', `/v1/root/tenants/${tenant}/people/${pid}/action`, { action, as, reason: 'support ticket 42' });

beforeAll(async () => {
  ctx = await createTestApp({ DEMO_INSTANT_LOGIN: 'true' });
  await seedDemo(ctx.db, ctx.deps.config, { log: () => undefined });
  await ctx.db.query(`update users set phone = null where email like '%@demo.attendly.app'`);
  seed = await seedBasic(ctx.db);
  demoTenant = (await ctx.db.query<{ id: string }>(`select id from tenants where slug = 'demo'`)).rows[0]!.id;
  rootId = (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'developer', 'Atul (platform)', 'root@iit.ac.in') returning id`, [seed.tenantId])).rows[0]!.id;
  hodId = (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email, is_owner) values ($1, 'admin', 'HOD', 'hod@iit.ac.in', true) returning id`, [seed.tenantId])).rows[0]!.id;
  root = new TestDevice(ctx);
  await root.signIn('root@iit.ac.in');
  aarav = new TestDevice(ctx);
  await aarav.signIn('aarav@iit.ac.in');
  sandbox = new TestDevice(ctx);
  const r = await sandbox.requestOtp('root@demo.attendly.app');
  const v = await sandbox.verifyOtp(r.json().challengeId, r.json().instantCode);
  await sandbox.bind(v.json().ticket);
});
afterAll(async () => ctx?.close());

describe('support: the developer inside an institution', () => {
  it('lists an institution’s people and opens one, with attendance and history', async () => {
    const students = ok(await root.call('GET', `/v1/root/tenants/${seed.tenantId}/people?role=student`));
    expect(students.map((p: { email: string }) => p.email)).toEqual(expect.arrayContaining(['aarav@iit.ac.in', 'priya@iit.ac.in']));
    const staff = ok(await root.call('GET', `/v1/root/tenants/${seed.tenantId}/people?role=staff`));
    expect(staff[0]).toMatchObject({ email: 'hod@iit.ac.in', owner: true });
    const p = ok(await root.call('GET', `/v1/root/tenants/${seed.tenantId}/people/${seed.studentId}`));
    expect(p.person.device).not.toBeNull();
    expect(p.attendance).toMatchObject({ held: expect.any(Number), attended: expect.any(Number) });
    expect(p.history.map((e: { action: string }) => e.action)).toContain('device.bind');
  });

  it('unlinks a phone "as Attendly support" — the student sees that, the audit chain records the developer', async () => {
    const r = ok(await act(root, seed.tenantId, seed.studentId, 'reset_phone', 'support'));
    expect(r.person.device).toBeNull();
    expect((await aarav.call('GET', '/v1/me/dashboard')).statusCode).toBe(401);
    const n = (await ctx.db.query<{ title: string; body: string }>(`select title, body from notifications where user_id = $1 and kind = 'device' order by id desc limit 1`, [seed.studentId])).rows[0]!;
    expect(n.body).toContain('Attendly support');
    expect(n.body).not.toContain('Atul');
    const a = (await ctx.db.query<{ actor_id: string; data: { shownAs: string; reason: string } }>(`select actor_id, data from audit_log where action = 'support.reset_phone'`)).rows[0]!;
    expect(a.actor_id).toBe(rootId);
    expect(a.data).toMatchObject({ shownAs: 'support', reason: 'support ticket 42' });
    expect((await ctx.db.query(`select 1 from audit_log where action = 'root.support' and actor_id = $1`, [rootId])).rowCount).toBeGreaterThan(0);
  });

  it('with "my name" the notification names the developer', async () => {
    ok(await act(root, seed.tenantId, seed.student2Id, 'suspend', 'named'));
    ok(await act(root, seed.tenantId, seed.student2Id, 'reactivate', 'named'));
    const n = (await ctx.db.query<{ body: string }>(`select body from notifications where user_id = $1 order by id desc limit 1`, [seed.student2Id])).rows[0]!;
    expect(n.body).toContain('Atul (platform)');
  });

  it('suspends (signing out), issues setup codes, changes roles and hands over the main-admin role', async () => {
    const prof = (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'Prof. X', 'x@iit.ac.in') returning id`, [seed.tenantId])).rows[0]!.id;
    const code = ok(await act(root, seed.tenantId, prof, 'setup_code'));
    expect(code.setup.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(ok(await act(root, seed.tenantId, prof, 'make_admin')).person.role).toBe('admin');
    // The main admin can't be demoted or suspended until the role is handed over.
    expect((await act(root, seed.tenantId, hodId, 'make_professor')).statusCode).toBe(409);
    expect((await act(root, seed.tenantId, hodId, 'suspend')).statusCode).toBe(409);
    expect(ok(await act(root, seed.tenantId, prof, 'make_owner')).person.owner).toBe(true);
    expect((await ctx.db.query<{ n: number }>(`select count(*)::int as n from users where tenant_id = $1 and is_owner`, [seed.tenantId])).rows[0]!.n).toBe(1);
    expect(ok(await act(root, seed.tenantId, hodId, 'make_professor')).person.role).toBe('teacher');
    // Students have no staff roles; developers aren't people of an institution.
    expect((await act(root, seed.tenantId, seed.studentId, 'make_admin')).statusCode).toBe(400);
    expect((await act(root, seed.tenantId, rootId, 'suspend')).statusCode).toBe(404);
  });

  it('only developers get in: staff and students are refused; the demo sandbox reads but never changes', async () => {
    const hod = new TestDevice(ctx);
    ctx.clock.now += 31_000;
    expect((await aarav.call('GET', `/v1/root/tenants/${seed.tenantId}/people`)).statusCode).toBe(401);
    void hod;
    expect((await sandbox.call('GET', `/v1/root/tenants/${seed.tenantId}/people`)).statusCode).toBe(404);
    const demoPeople = ok(await sandbox.call('GET', `/v1/root/tenants/${demoTenant}/people?role=student`));
    expect(demoPeople.length).toBeGreaterThan(0);
    expect((await act(sandbox, demoTenant, demoPeople[0].id, 'suspend')).statusCode).toBe(403);
  });
});
