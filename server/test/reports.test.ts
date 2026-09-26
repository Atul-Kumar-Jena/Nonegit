import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MatrixReport, StudentReport } from '@attendly/protocol';
import { createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let teacher: TestDevice;
let aarav: TestDevice;
let priya: TestDevice;
let batchId: string;

async function mark(sessionId: string, userId: string) {
  await ctx.db.query(
    `insert into attendance_records(session_id, user_id, marked_at, qr_seq, receipt_signature, server_key_id, device_fingerprint, source)
     values ($1, $2, now(), 0, '\\x00', 'k', 'f', 'manual')`,
    [sessionId, userId],
  );
}

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  // A teacher who teaches none of these subjects: may still read any student's attendance.
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'Dr. Other', 'other@iit.ac.in')`, [seed.tenantId]);
  const b = await ctx.db.query<{ id: string }>(`insert into batches(tenant_id, name) values ($1, 'CSE-A') returning id`, [seed.tenantId]);
  batchId = b.rows[0]!.id;
  await ctx.db.query('insert into batch_members(batch_id, user_id) values ($1, $2)', [batchId, seed.studentId]);

  const day = 86_400_000;
  const s1 = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'closed', startedAt: ctx.clock.now - 3 * day });
  const s2 = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'closed', startedAt: ctx.clock.now - 2 * day });
  const s3 = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.otherCourseId, status: 'closed', startedAt: ctx.clock.now - day });
  await mark(s1.id, seed.studentId);
  await mark(s2.id, seed.studentId);
  await mark(s1.id, seed.student2Id);
  await mark(s3.id, seed.student2Id);

  teacher = new TestDevice(ctx);
  await teacher.signIn('other@iit.ac.in');
  aarav = new TestDevice(ctx);
  await aarav.signIn('aarav@iit.ac.in');
  priya = new TestDevice(ctx);
  await priya.signIn('priya@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('attendance reports', () => {
  it('a student gets their own report, per subject and overall', async () => {
    const r = await priya.call('GET', '/v1/me/report');
    expect(r.statusCode).toBe(200);
    const rep = StudentReport.parse(r.json());
    expect(rep.institution).toBe('IIT Test');
    expect(rep.subjects.map((s) => [s.code, s.attended, s.held])).toEqual([
      ['CS-301', 1, 2],
      ['MA-202', 1, 1],
    ]);
    expect(rep.total).toMatchObject({ attended: 2, held: 3, percent: 66.7 });
    expect(rep.classes).toBeNull();
  });

  it('one subject comes with its class-by-class log', async () => {
    const rep = StudentReport.parse((await priya.call('GET', `/v1/me/report?courseId=${seed.courseId}`)).json());
    expect(rep.subjects).toHaveLength(1);
    expect(rep.classes!.map((c) => c.status)).toEqual(['present', 'absent']);
    expect(rep.classes![0]!.how).toBe('Register');
  });

  it('any teacher can read any student in their institution, but not other institutions', async () => {
    const r = await teacher.call('GET', `/v1/staff/students/${seed.studentId}/report`);
    expect(r.statusCode).toBe(200);
    expect(StudentReport.parse(r.json()).student.batches).toEqual(['CSE-A']);
    expect((await teacher.call('GET', `/v1/staff/students/${seed.outsiderId}/report`)).statusCode).toBe(404);
  });

  it('students cannot read the staff reports', async () => {
    expect((await aarav.call('GET', `/v1/staff/students/${seed.student2Id}/report`)).statusCode).toBe(403);
    expect((await aarav.call('GET', '/v1/staff/reports/matrix')).statusCode).toBe(403);
  });

  it('cumulative: everyone × every subject, blanks where not enrolled', async () => {
    const raw = await teacher.call('GET', '/v1/staff/reports/matrix');
    const rep = MatrixReport.parse(raw.json());
    expect(rep.scope.label).toBe('All students');
    expect(rep.courses.map((c) => c.code)).toEqual(['CS-301', 'MA-202']);
    const aaravRow = rep.students.find((s) => s.userId === seed.studentId)!;
    expect(aaravRow.cells).toEqual([{ attended: 2, held: 2 }, null]);
    expect(aaravRow.percent).toBe(100);
    expect(rep.students.some((s) => s.userId === seed.outsiderId)).toBe(false);
  });

  it('by batch and by subject', async () => {
    const byBatch = MatrixReport.parse((await teacher.call('GET', `/v1/staff/reports/matrix?batchId=${batchId}`)).json());
    expect(byBatch.scope.label).toBe('CSE-A');
    expect(byBatch.students.map((s) => s.userId)).toEqual([seed.studentId]);
    const bySubject = MatrixReport.parse((await teacher.call('GET', `/v1/staff/reports/matrix?courseId=${seed.otherCourseId}`)).json());
    expect(bySubject.courses.map((c) => c.code)).toEqual(['MA-202']);
    expect(bySubject.students.map((s) => [s.userId, s.cells[0]])).toEqual([[seed.student2Id, { attended: 1, held: 1 }]]);
    expect((await teacher.call('GET', `/v1/staff/reports/matrix?courseId=${seed.foreignCourseId}`)).statusCode).toBe(404);
  });
});
