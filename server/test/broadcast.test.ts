import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let root: TestDevice;
let aarav: TestDevice;
let hod: TestDevice;
let prof: TestDevice;
let zed: TestDevice;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const inbox = async (d: TestDevice) => ok(await d.call('GET', '/v1/notices')).items ?? ok(await d.call('GET', '/v1/notices'));
const titles = async (d: TestDevice) => {
  const r = await inbox(d);
  return (Array.isArray(r) ? r : r.notices ?? r.items).map((n: { title: string }) => n.title);
};

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  await ctx.db.query(`update tenants set verified_at = now()`);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'developer', 'Atul', 'root@iit.ac.in')`, [seed.tenantId]);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email, is_owner) values ($1, 'admin', 'HOD', 'hod@iit.ac.in', true)`, [seed.tenantId]);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'Prof', 'prof@iit.ac.in')`, [seed.tenantId]);
  root = new TestDevice(ctx);
  aarav = new TestDevice(ctx);
  hod = new TestDevice(ctx);
  prof = new TestDevice(ctx);
  zed = new TestDevice(ctx);
  await root.signIn('root@iit.ac.in');
  await aarav.signIn('aarav@iit.ac.in');
  await hod.signIn('hod@iit.ac.in');
  await prof.signIn('prof@iit.ac.in');
  await zed.signIn('zed@other.edu');
});
afterAll(async () => ctx?.close());

describe('broadcasts from the Developer app', () => {
  it('previews how many people in how many institutions', async () => {
    const all = ok(await root.call('POST', '/v1/root/broadcast/preview', { audience: 'students' }));
    expect(all.institutions).toBe(2);
    expect(all.recipients).toBeGreaterThanOrEqual(3);
    const one = ok(await root.call('POST', '/v1/root/broadcast/preview', { audience: 'admins', tenantId: seed.tenantId }));
    expect(one).toMatchObject({ institutions: 1, recipients: 1 });
  });

  it('to admins only: admins see it (signed “Attendly”), professors and students don’t', async () => {
    const b = ok(await root.call('POST', '/v1/root/broadcast', { audience: 'admins', title: 'Planned maintenance Sunday', body: 'Attendly is down 2–3 AM.', important: true }));
    expect(b).toMatchObject({ audienceLabel: 'All admins', signedAs: 'Attendly', institutions: 2 });
    expect(await titles(hod)).toContain('Planned maintenance Sunday');
    expect(await titles(prof)).not.toContain('Planned maintenance Sunday');
    expect(await titles(aarav)).not.toContain('Planned maintenance Sunday');
    const n = (await ctx.db.query<{ title: string; body: string }>(`select title, body from notifications where kind = 'notice' and body like 'Attendly:%'`)).rows;
    expect(n[0]!.title).toContain('Important');
    // Read-only for the institution: not even its admin can edit or delete it.
    const id = (await ctx.db.query<{ id: string }>(`select id from notices where broadcast_id = $1 and tenant_id = $2`, [b.id, seed.tenantId])).rows[0]!.id;
    const detail = ok(await hod.call('GET', `/v1/notices/${id}`));
    expect(detail.author.name).toBe('Attendly');
    expect(detail.canEdit).toBe(false);
    expect((await hod.call('POST', `/v1/notices/${id}/delete`, {})).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('to students of one institution, signed with the developer’s name', async () => {
    ok(await root.call('POST', '/v1/root/broadcast', { audience: 'students', tenantId: seed.tenantId, title: 'New app version', body: 'Update Attendly today.', as: 'named' }));
    expect(await titles(aarav)).toContain('New app version');
    expect(await titles(zed)).not.toContain('New app version'); // other institution
    expect(await titles(prof)).not.toContain('New app version');
  });

  it('to everyone: history with reach and reads; withdrawing removes it everywhere; all on the audit chain', async () => {
    const b = ok(await root.call('POST', '/v1/root/broadcast', { audience: 'everyone', title: 'Welcome to Attendly', body: 'Hello!' }));
    expect(await titles(prof)).toContain('Welcome to Attendly');
    expect(await titles(zed)).toContain('Welcome to Attendly');
    const id = (await ctx.db.query<{ id: string }>(`select id from notices where broadcast_id = $1 and tenant_id = $2`, [b.id, seed.tenantId])).rows[0]!.id;
    ok(await aarav.call('GET', `/v1/notices/${id}`));
    await aarav.call('POST', `/v1/notices/${id}/read`, {});
    const list = ok(await root.call('GET', '/v1/root/broadcasts'));
    expect(list.map((x: { title: string }) => x.title)).toEqual(['Welcome to Attendly', 'New app version', 'Planned maintenance Sunday']);
    expect(list[0].recipients).toBeGreaterThanOrEqual(5);
    ok(await root.call('POST', `/v1/root/broadcasts/${b.id}/withdraw`, {}));
    expect(await titles(prof)).not.toContain('Welcome to Attendly');
    const audit = (await ctx.db.query<{ action: string }>(`select action from audit_log where action like 'root.broadcast%' or action = 'notice.platform_send'`)).rows.map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['root.broadcast', 'notice.platform_send', 'root.broadcast_withdraw']));
  });

  it('only developers can broadcast', async () => {
    expect((await hod.call('POST', '/v1/root/broadcast', { audience: 'everyone', title: 'x', body: 'y' })).statusCode).toBe(403);
  });
});
