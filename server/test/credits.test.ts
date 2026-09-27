import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreditResult, SubjectDetailResponse } from '@attendly/protocol';
import { createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let admin: TestDevice;
let prof: TestDevice;
let other: TestDevice;
let aarav: TestDevice;
const held: string[] = [];

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  const mk = async (role: string, email: string) =>
    (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, $2, $3, $4) returning id`, [seed.tenantId, role, email.split('@')[0], email])).rows[0]!.id;
  await mk('admin', 'hod@iit.ac.in');
  const profId = await mk('teacher', 'kumar@iit.ac.in');
  await mk('teacher', 'other@iit.ac.in');
  await ctx.db.query('update courses set instructor_id = $1 where id = $2', [profId, seed.courseId]);
  admin = new TestDevice(ctx, { hardwareId: 'admin' });
  prof = new TestDevice(ctx, { hardwareId: 'prof' });
  other = new TestDevice(ctx, { hardwareId: 'other' });
  aarav = new TestDevice(ctx, { hardwareId: 'aarav' });
  await admin.signIn('hod@iit.ac.in');
  await prof.signIn('kumar@iit.ac.in');
  await other.signIn('other@iit.ac.in');
  await aarav.signIn('aarav@iit.ac.in');
  // 10 held (closed) CS-301 classes over the last 10 days; Aarav attended none.
  for (let i = 10; i >= 1; i--) {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, startedAt: ctx.clock.now - i * 86_400_000 });
    await ctx.db.query(`update class_sessions set status = 'closed', ended_at = started_at + interval '1 hour' where id = $1`, [s.id]);
    held.push(s.id);
  }
});
afterAll(async () => ctx?.close());

const credit = (d: TestDevice, body: Record<string, unknown>) => d.call('POST', `/v1/staff/students/${seed.studentId}/credit`, body);

describe('attendance credit', () => {
  it('previews first: 20% of 10 held classes = 2 classes, 0% → 20%', async () => {
    const p = CreditResult.parse(ok(await credit(admin, { courseId: seed.courseId, reason: 'medical', note: 'Hospitalised, certificate seen', amount: { kind: 'percent', percent: 20 }, preview: true })));
    expect(p).toMatchObject({ preview: true, credited: 2, creditId: null });
    expect(p.perSubject[0]).toMatchObject({ code: 'CS-301', credited: 2, before: 0, after: 20 });
    expect((await ctx.db.query(`select 1 from attendance_records where source = 'credit'`)).rowCount).toBe(0);
  });

  it('the subject’s professor gives 3 classes for a fest; the student is told and sees it on each class', async () => {
    const r = CreditResult.parse(ok(await credit(prof, { courseId: seed.courseId, reason: 'event', note: 'Represented the college at TechFest', amount: { kind: 'classes', classes: 3 } })));
    expect(r).toMatchObject({ preview: false, credited: 3 });
    const n = (await ctx.db.query(`select title, body from notifications where user_id = $1 and kind = 'attendance'`, [seed.studentId])).rows;
    expect(n.at(-1)?.title).toBe('🎖 Attendance credit · Fest / event');
    expect(n.at(-1)?.body).toMatch(/3 classes counted as attended[\s\S]*CS-301: \+3 → 30%[\s\S]*TechFest/);
    const d = SubjectDetailResponse.parse(ok(await aarav.call('GET', `/v1/me/subjects/${seed.courseId}`)));
    expect(d.subject).toMatchObject({ attended: 3, held: 10, percent: 30 });
    const credited = d.history.filter((h) => h.credit);
    expect(credited).toHaveLength(3);
    expect(credited[0]).toMatchObject({ status: 'present', source: 'credit', credit: { reason: 'Fest / event', note: 'Represented the college at TechFest' } });
  });

  it('only missed classes on chosen dates (a medical leave), or exactly the classes picked', async () => {
    const day = (i: number) => new Date(ctx.clock.now - i * 86_400_000).toISOString().slice(0, 10);
    // Leave covering the 9th and 8th day back (not yet credited: the fest credit took the latest three).
    const r = CreditResult.parse(ok(await credit(admin, { courseId: seed.courseId, reason: 'medical', note: 'Viral fever, doctor’s note', amount: { kind: 'classes', classes: 50 }, from: day(9), to: day(8) })));
    expect(r.credited).toBe(2);
    const missed = ok(await admin.call('GET', `/v1/staff/students/${seed.studentId}/missed?courseId=${seed.courseId}`));
    expect(missed).toHaveLength(5);
    const pick = CreditResult.parse(ok(await credit(admin, { courseId: seed.courseId, reason: 'sports', note: 'State athletics meet', amount: { kind: 'sessions', sessionIds: [missed[0].sessionId] } })));
    expect(pick.credited).toBe(1);
    // A class that isn't missed can't be picked.
    expect((await credit(admin, { courseId: seed.courseId, reason: 'other', note: 'Duplicate', amount: { kind: 'sessions', sessionIds: [missed[0].sessionId] } })).statusCode).toBe(400);
  });

  it('other professors can’t credit subjects they don’t teach; a note is required', async () => {
    expect((await credit(other, { courseId: seed.courseId, reason: 'medical', note: 'Some note', amount: { kind: 'classes', classes: 1 } })).statusCode).toBe(403);
    expect((await credit(prof, { courseId: null, reason: 'medical', note: 'Some note', amount: { kind: 'classes', classes: 1 } })).statusCode).toBe(403);
    expect((await credit(admin, { courseId: seed.courseId, reason: 'medical', note: '', amount: { kind: 'classes', classes: 1 } })).statusCode).toBe(400);
  });

  it('a credit can be undone, and the history shows who gave what', async () => {
    const list = ok(await admin.call('GET', `/v1/staff/students/${seed.studentId}/credits`));
    expect(list.map((c: { reason: string; credited: number }) => `${c.reason}:${c.credited}`).sort()).toEqual(['event:3', 'medical:2', 'sports:1']);
    const fest = list.find((c: { reason: string }) => c.reason === 'event');
    expect(fest.by).toBe('kumar');
    ok(await prof.call('POST', `/v1/staff/credits/${fest.id}/undo`, {}));
    const d = SubjectDetailResponse.parse(ok(await aarav.call('GET', `/v1/me/subjects/${seed.courseId}`)));
    expect(d.subject.attended).toBe(3);
    expect((await prof.call('POST', `/v1/staff/credits/${fest.id}/undo`, {})).statusCode).toBe(409);
  });
});
