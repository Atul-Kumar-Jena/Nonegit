import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaffMe } from '@attendly/protocol';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let admin: TestDevice;
let prof: TestDevice;
let adminId: string;
let profId: string;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const grant = (permissions: string[], role: 'teacher' | 'admin' = 'teacher', id = profId) => admin.call('POST', `/v1/staff/people/${id}/access`, { role, permissions });

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  const mk = async (role: string, email: string) =>
    (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, $2, $3, $4) returning id`, [seed.tenantId, role, email.split('@')[0], email])).rows[0]!.id;
  adminId = await mk('admin', 'hod@iit.ac.in');
  profId = await mk('teacher', 'kumar@iit.ac.in');
  admin = new TestDevice(ctx);
  prof = new TestDevice(ctx);
  await admin.signIn('hod@iit.ac.in');
  await prof.signIn('kumar@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('professor vs admin', () => {
  it('a plain professor teaches, but can’t run the institution', async () => {
    expect(StaffMe.parse(ok(await prof.call('GET', '/v1/staff/me'))).permissions).toEqual([]);
    expect(StaffMe.parse(ok(await admin.call('GET', '/v1/staff/me'))).permissions).toEqual(['people', 'courses', 'planner', 'devices']);
    const planner = await prof.call('GET', '/v1/staff/planner');
    expect(planner.statusCode).toBe(403);
    expect(planner.json().error.message).toContain('Planner & cover');
    expect((await prof.call('POST', '/v1/staff/people', { role: 'student', fullName: 'X', email: 'x@iit.ac.in' })).statusCode).toBe(403);
    expect((await prof.call('GET', '/v1/staff/device-requests')).statusCode).toBe(403);
    expect((await prof.call('POST', '/v1/staff/courses', { code: 'NEW-1', title: 'New' })).statusCode).toBe(403);
    expect((await prof.call('GET', '/v1/staff/people?role=staff')).statusCode).toBe(403);
  });

  it('only admins manage roles — a professor can’t grant themselves anything', async () => {
    expect((await prof.call('POST', `/v1/staff/people/${profId}/access`, { role: 'admin', permissions: [] })).statusCode).toBe(403);
    expect((await prof.call('POST', `/v1/staff/people/${profId}/access`, { role: 'teacher', permissions: ['people'] })).statusCode).toBe(403);
  });

  it('“Planner & cover” opens the planner and handing classes out', async () => {
    const p = ok(await grant(['planner']));
    expect(p).toMatchObject({ role: 'teacher', permissions: ['planner'] });
    expect((await prof.call('GET', '/v1/staff/planner')).statusCode).toBe(200);
    expect(StaffMe.parse(ok(await prof.call('GET', '/v1/staff/me'))).permissions).toEqual(['planner']);
    const bell = ok(await prof.call('GET', '/v1/notifications'));
    expect(bell.items[0]).toMatchObject({ title: 'Your permissions changed', body: 'You can now use: Planner & cover.' });
    expect((await prof.call('GET', '/v1/staff/device-requests')).statusCode).toBe(403); // only what was granted
  });

  it('“People” lets them add students and professors, but never admins or edit an admin', async () => {
    ok(await grant(['people']));
    expect((await prof.call('GET', '/v1/staff/planner')).statusCode).toBe(403); // planner was replaced, not added
    ok(await prof.call('POST', '/v1/staff/people', { role: 'student', fullName: 'Nisha', email: 'nisha@iit.ac.in', rollNo: 'N1' }));
    ok(await prof.call('POST', '/v1/staff/people', { role: 'teacher', fullName: 'Dr. Rao', email: 'rao@iit.ac.in' }));
    expect((await prof.call('POST', '/v1/staff/people', { role: 'admin', fullName: 'Boss', email: 'boss@iit.ac.in' })).statusCode).toBe(403);
    expect((await prof.call('POST', `/v1/staff/people/${adminId}`, { fullName: 'Hacked' })).statusCode).toBe(403);
    expect(ok(await prof.call('GET', '/v1/staff/people?role=staff')).length).toBeGreaterThanOrEqual(3);
  });

  it('“Courses & timetable” shows every course and allows creating one', async () => {
    ok(await grant(['courses']));
    const all = ok(await prof.call('GET', '/v1/staff/courses'));
    expect(all.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(['CS-301', 'MA-202']));
    ok(await prof.call('POST', '/v1/staff/courses', { code: 'NEW-1', title: 'New course' }));
  });

  it('“Phones & scans” opens phone requests; removing a permission takes effect at once', async () => {
    ok(await grant(['devices']));
    expect((await prof.call('GET', '/v1/staff/device-requests')).statusCode).toBe(200);
    ok(await grant([]));
    expect((await prof.call('GET', '/v1/staff/device-requests')).statusCode).toBe(403);
  });

  it('promotes a professor to admin and back; an institution always keeps one admin', async () => {
    expect(ok(await grant(['planner'], 'admin'))).toMatchObject({ role: 'admin', permissions: [] });
    expect(StaffMe.parse(ok(await prof.call('GET', '/v1/staff/me'))).permissions).toHaveLength(4);
    // Two admins: one can step the other down…
    expect(ok(await grant(['planner'], 'teacher'))).toMatchObject({ role: 'teacher', permissions: ['planner'] });
    // …but the last admin can't be demoted.
    const last = await grant([], 'teacher', adminId);
    expect(last.statusCode).toBe(409);
    expect(last.json().error.message).toContain('at least one admin');
    const audit = await ctx.db.query(`select 1 from audit_log where action = 'person.access'`);
    expect(audit.rowCount).toBeGreaterThanOrEqual(6);
  });
});
