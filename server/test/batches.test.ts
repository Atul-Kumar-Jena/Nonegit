import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BatchDetail, BulkImportResponse } from '@attendly/protocol';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let admin: TestDevice;
let prof: TestDevice;
let other: TestDevice;
let profId: string;
let batchId: string;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const semesterOf = async (id: string) => (await ctx.db.query<{ semester: number | null; department: string | null }>('select semester, department from users where id = $1', [id])).rows[0]!;

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  const mk = async (role: string, email: string) =>
    (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, $2, $3, $4) returning id`, [seed.tenantId, role, email.split('@')[0], email])).rows[0]!.id;
  await mk('admin', 'hod@iit.ac.in');
  profId = await mk('teacher', 'kumar@iit.ac.in');
  await mk('teacher', 'rao@iit.ac.in');
  admin = new TestDevice(ctx);
  prof = new TestDevice(ctx);
  other = new TestDevice(ctx);
  await admin.signIn('hod@iit.ac.in');
  await prof.signIn('kumar@iit.ac.in');
  await other.signIn('rao@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('batch → students → subjects, run by professors', () => {
  it('a professor creates a batch with its department and semester', async () => {
    const b = ok(await prof.call('POST', '/v1/staff/batches', { name: 'CSE-5A', department: 'CSE', semester: 5 }));
    expect(b).toMatchObject({ name: 'CSE-5A', department: 'CSE', semester: 5, createdBy: profId, canManage: true, size: 0 });
    batchId = b.id;
    const seen = ok(await other.call('GET', '/v1/staff/batches')).find((x: { id: string }) => x.id === batchId);
    expect(seen).toMatchObject({ canManage: false, semester: 5 });
  });

  it('adding students batch-wise gives them the batch’s semester', async () => {
    ok(await prof.call('POST', `/v1/staff/batches/${batchId}`, { addMembers: [seed.studentId] }));
    expect(await semesterOf(seed.studentId)).toEqual({ semester: 5, department: 'CSE' });
  });

  it('pasting a class list: new students are created, already-registered ones are added', async () => {
    const r = BulkImportResponse.parse(
      ok(
        await prof.call('POST', '/v1/staff/people/import', {
          batchId,
          rows: [
            { fullName: 'Nisha Rao', rollNo: 'N1', email: 'nisha@iit.ac.in' },
            { fullName: 'priya (again)', rollNo: 'priya' }, // seedBasic gives priya roll no. "priya"
            { fullName: 'Sneaky', rollNo: 'T9', email: 't9@iit.ac.in', role: 'teacher' }, // teachers only ever add students
          ],
        }),
      ),
    );
    expect(r).toMatchObject({ created: 2, addedExisting: 1, skipped: [] });
    const roles = await ctx.db.query<{ role: string }>(`select role from users where roll_no = 'T9'`);
    expect(roles.rows[0]!.role).toBe('student');
    const d = BatchDetail.parse(ok(await prof.call('GET', `/v1/staff/batches/${batchId}`)));
    expect(d.size).toBe(4);
    expect(await semesterOf(seed.student2Id)).toMatchObject({ semester: 5 });
    // Without a batch, bulk import stays admin-only.
    expect((await prof.call('POST', '/v1/staff/people/import', { rows: [{ fullName: 'X', rollNo: 'X1' }] })).statusCode).toBe(403);
  });

  it('a professor creates a subject inside the batch: they teach it and every student is enrolled', async () => {
    const d = BatchDetail.parse(ok(await prof.call('POST', `/v1/staff/batches/${batchId}/subjects`, { code: 'cs-501', title: 'Compilers', instructorId: seed.studentId })));
    const c = d.courses.find((x) => x.code === 'CS-501')!;
    expect(c).toMatchObject({ title: 'Compilers', canOpen: true });
    expect(c.instructor!.id).toBe(profId); // a teacher can't make someone else the instructor
    const n = await ctx.db.query('select 1 from enrollments where course_id = $1', [c.id]);
    expect(n.rowCount).toBe(4);
    expect((await prof.call('POST', `/v1/staff/batches/${batchId}/subjects`, { code: 'CS-501', title: 'Again' })).statusCode).toBe(409);
  });

  it('another professor can add, but not remove, rename, archive or re-semester', async () => {
    const d = BatchDetail.parse(ok(await other.call('POST', `/v1/staff/batches/${batchId}`, { courseIds: [...(await ids()), seed.otherCourseId] })));
    expect(d.courses.find((c) => c.id === seed.otherCourseId)?.canOpen).toBe(false);
    for (const body of [{ removeMembers: [seed.studentId] }, { name: 'X' }, { active: false }, { semester: 6 }, { courseIds: [seed.otherCourseId] }]) {
      const r = await other.call('POST', `/v1/staff/batches/${batchId}`, body);
      expect(r.statusCode).toBe(403);
    }
    // Admins can do everything.
    ok(await admin.call('POST', `/v1/staff/batches/${batchId}`, { courseIds: await ids().then((x) => x.filter((c) => c !== seed.otherCourseId)) }));
  });

  it('moving the batch to the next semester moves all its students', async () => {
    ok(await prof.call('POST', `/v1/staff/batches/${batchId}`, { semester: 6 }));
    const r = await ctx.db.query<{ semester: number }>('select u.semester from batch_members m join users u on u.id = m.user_id where m.batch_id = $1', [batchId]);
    expect(r.rows.map((x) => x.semester)).toEqual([6, 6, 6, 6]);
  });

  it('any professor can find any student to add (names only, no contact details)', async () => {
    const hits = ok(await other.call('GET', `/v1/staff/students/search?q=aar`));
    expect(hits).toEqual([expect.objectContaining({ userId: seed.studentId, rollNo: 'aarav', semester: 6, batches: ['CSE-5A'] })]);
    expect(Object.keys(hits[0])).not.toContain('email');
    const notIn = ok(await other.call('GET', `/v1/staff/students/search?notInBatch=${batchId}`));
    expect(notIn.some((h: { userId: string }) => h.userId === seed.studentId)).toBe(false);
    expect(notIn.some((h: { userId: string }) => h.userId === seed.outsiderId)).toBe(false); // other institution
  });

  it('every subject of the institution can be listed to add to a batch', async () => {
    const mine = ok(await other.call('GET', '/v1/staff/courses'));
    const all = ok(await other.call('GET', '/v1/staff/courses?scope=all'));
    expect(mine).toHaveLength(0);
    expect(all.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(['CS-301', 'MA-202', 'CS-501']));
  });
});

async function ids(): Promise<string[]> {
  return BatchDetail.parse(ok(await admin.call('GET', `/v1/staff/batches/${batchId}`))).courseIds;
}
