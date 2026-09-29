import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, createTestApp, liveToken, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let aarav: TestDevice;
let admin: TestDevice;
let prof: TestDevice;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email, is_owner) values ($1, 'admin', 'HOD', 'hod@iit.ac.in', true)`, [seed.tenantId]);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'Prof', 'prof@iit.ac.in')`, [seed.tenantId]);
  await ctx.db.query(`update courses set instructor_id = (select id from users where email = 'prof@iit.ac.in') where id = $1`, [seed.courseId]);
  const b = (await ctx.db.query<{ id: string }>(`insert into batches(tenant_id, name) values ($1, 'CSE 2 A') returning id`, [seed.tenantId])).rows[0]!.id;
  await ctx.db.query(`insert into batch_members(batch_id, user_id) values ($1, $2), ($1, $3)`, [b, seed.studentId, seed.student2Id]);
  await ctx.db.query(`insert into course_batches(course_id, batch_id) values ($1, $2)`, [seed.courseId, b]);
  aarav = new TestDevice(ctx);
  admin = new TestDevice(ctx);
  prof = new TestDevice(ctx);
  await aarav.signIn('aarav@iit.ac.in');
  await admin.signIn('hod@iit.ac.in');
  await prof.signIn('prof@iit.ac.in');
  // One class today: Aarav scans, Priya doesn't; then it ends.
  const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, rotationS: 5 });
  ok(await aarav.call('POST', '/v1/attendance/mark', { qr: liveToken(ctx, s, 5), location: { ...at(5), accuracyM: 8, mocked: false, capturedAt: ctx.clock.now } }));
  await ctx.db.query(`update class_sessions set status = 'closed', ended_at = now() where id = $1`, [s.id]);
});
afterAll(async () => ctx?.close());

describe('analytics', () => {
  it('per day, per subject, per batch and the spread of students — for the admin', async () => {
    const a = ok(await admin.call('GET', '/v1/staff/analytics?days=30'));
    expect(a.scope).toMatchObject({ label: 'Whole institution', mine: false });
    expect(a.days).toHaveLength(1);
    expect(a.days[0]).toMatchObject({ classes: 1, expected: 2, present: 1, percent: 50 });
    expect(a.subjects[0]).toMatchObject({ code: 'CS-301', percent: 50 });
    expect(a.batches[0]).toMatchObject({ name: 'CSE 2 A', expected: 2, present: 1 });
    expect(a.batchDays[0]).toMatchObject({ expected: 2, present: 1 });
    expect(a.bands.safe + a.bands.near + a.bands.below + a.bands.far).toBe(2);
  });

  it('a professor sees their own classes; a student sees their week-by-week trend', async () => {
    expect(ok(await prof.call('GET', '/v1/staff/analytics?days=7')).scope).toMatchObject({ mine: true, label: 'My classes' });
    const t = ok(await aarav.call('GET', '/v1/me/trend'));
    expect(t.weeks.at(-1)).toMatchObject({ attended: 1, held: 1, percent: 100 });
    expect((await aarav.call('GET', '/v1/staff/analytics')).statusCode).toBe(403);
  });
});

describe('reports for any dates, batch, subject or professor', () => {
  it('a date range (e.g. this month) and one professor: how many of their students attended', async () => {
    const today = new Date(ctx.clock.now).toISOString().slice(0, 10);
    const profId = (await ctx.db.query<{ id: string }>(`select id from users where email = 'prof@iit.ac.in'`)).rows[0]!.id;
    const a = ok(await admin.call('GET', `/v1/staff/analytics?from=${today.slice(0, 8)}01&to=${today}&teacherId=${profId}`));
    expect(a.scope).toMatchObject({ teacherId: profId, mine: false });
    expect(a.scope.label).toContain('Prof');
    expect(a.teachers).toEqual([expect.objectContaining({ name: 'Prof', expected: 2, present: 1, percent: 50 })]);
    // A range with no classes is empty, not an error; a backwards range is refused.
    expect(ok(await admin.call('GET', '/v1/staff/analytics?from=2020-01-01&to=2020-03-31')).days).toEqual([]);
    expect((await admin.call('GET', '/v1/staff/analytics?from=2026-05-01&to=2026-04-01')).statusCode).toBe(400);
  });
});
