import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDaysYmd } from '@attendly/protocol';
import { createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';
import { verifyAuditChain } from '../src/lib/audit';

let ctx: TestCtx;
let seed: Seeded;
let admin: TestDevice;
let t1: TestDevice; // teaches CS-301 (aarav + priya)
let t2: TestDevice; // teaches MA-202 (priya)
let t3: TestDevice; // teaches nothing
let aarav: TestDevice;
let priya: TestDevice;
let adminId: string;
let t1Id: string;
let t2Id: string;
let t3Id: string;

const IST = 5.5 * 3_600_000;
const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const localToday = () => new Date(ctx.clock.now + IST).toISOString().slice(0, 10);
const istUtc = (ymd: string, hm: string) => Date.parse(`${ymd}T${hm}:00Z`) - IST;
async function scheduled(courseId: string, daysAhead: number, hm: string) {
  const ymd = addDaysYmd(localToday(), daysAhead);
  const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId, status: 'scheduled', startedAt: istUtc(ymd, hm) });
  return { ...s, ymd };
}
type Note = { title: string; body: string; data: Record<string, unknown> };
const newNotes = async (d: TestDevice, since: number) => {
  const all = ok(await d.call('GET', '/v1/notifications')).items as (Note & { id: number })[];
  return all.filter((n) => n.id > since);
};
const lastNoteId = async (d: TestDevice) => (ok(await d.call('GET', '/v1/notifications')).items[0]?.id as number | undefined) ?? 0;
const substituteOf = async (sessionId: string) =>
  (await ctx.db.query<{ substitute_id: string | null; change_note: string | null }>('select substitute_id, change_note from class_sessions where id = $1', [sessionId])).rows[0]!;

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  const mk = async (role: string, email: string, name: string) =>
    (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, $2, $3, $4) returning id`, [seed.tenantId, role, name, email])).rows[0]!.id;
  adminId = await mk('admin', 'principal@iit.ac.in', 'Dr. Principal');
  t1Id = await mk('teacher', 'kumar@iit.ac.in', 'Dr. Kumar');
  t2Id = await mk('teacher', 'rao@iit.ac.in', 'Dr. Rao');
  t3Id = await mk('teacher', 'sen@iit.ac.in', 'Dr. Sen');
  await ctx.db.query('update courses set instructor_id = $1 where id = $2', [t1Id, seed.courseId]);
  await ctx.db.query('update courses set instructor_id = $1 where id = $2', [t2Id, seed.otherCourseId]);
  admin = new TestDevice(ctx);
  t1 = new TestDevice(ctx);
  t2 = new TestDevice(ctx);
  t3 = new TestDevice(ctx);
  aarav = new TestDevice(ctx);
  priya = new TestDevice(ctx);
  await admin.signIn('principal@iit.ac.in');
  await t1.signIn('kumar@iit.ac.in');
  await t2.signIn('rao@iit.ac.in');
  await t3.signIn('sen@iit.ac.in');
  await aarav.signIn('aarav@iit.ac.in');
  await priya.signIn('priya@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('cover requests (admin drags a free teacher onto a class)', () => {
  it('assign now: the class is theirs at once and the students get the note straight away', async () => {
    const s = await scheduled(seed.courseId, 3, '12:00');
    const aaravBefore = await lastNoteId(aarav);
    const t3Before = await lastNoteId(t3);
    const r = ok(
      await admin.call('POST', '/v1/staff/cover-requests', { sessionId: s.id, teacherId: t3Id, mode: 'assign', noteToTeacher: 'Cover unit 3 please', noteToStudents: 'Bring your lab records' }),
    );
    expect(r.status).toBe('applied');
    expect(await substituteOf(s.id)).toEqual({ substitute_id: t3Id, change_note: 'Bring your lab records' });
    const studentNote = (await newNotes(aarav, aaravBefore))[0]!;
    expect(studentNote.title).toBe('Different teacher · CS-301');
    expect(studentNote.body).toContain('“Bring your lab records”');
    const teacherNotes = await newNotes(t3, t3Before);
    expect(teacherNotes.some((n) => n.body.includes('You’re taking CS-301'))).toBe(true);
    expect(teacherNotes.some((n) => n.body.includes('“Cover unit 3 please”'))).toBe(true);
  });

  it('asks the teacher with a note; nothing changes and no student hears anything until they accept', async () => {
    const s = await scheduled(seed.courseId, 2, '10:00');
    const aaravBefore = await lastNoteId(aarav);
    const r = ok(
      await admin.call('POST', '/v1/staff/cover-requests', { sessionId: s.id, teacherId: t3Id, noteToTeacher: 'Kumar is at a conference', noteToStudents: 'Dr. Sen covers chapter 4' }),
    );
    expect(r.status).toBe('sent');
    expect(r.request).toMatchObject({ kind: 'cover', status: 'pending', noteToTeacher: 'Kumar is at a conference', to: { id: t3Id }, from: { id: adminId } });
    expect((await substituteOf(s.id)).substitute_id).toBeNull();
    expect(await newNotes(aarav, aaravBefore)).toHaveLength(0);

    const asked = (await newNotes(t3, 0)).find((n) => n.data.requestId === r.request.id)!;
    expect(asked.title).toBe('Can you take CS-301?');
    expect(asked.body).toContain('“Kumar is at a conference”');

    // Only the asked teacher can answer.
    expect((await t2.call('POST', `/v1/staff/requests/${r.request.id}/accept`, {})).statusCode).toBe(403);
    expect(ok(await t3.call('GET', '/v1/staff/requests')).incoming[0]).toMatchObject({ id: r.request.id, status: 'pending' });

    const adminBefore = await lastNoteId(admin);
    const t3Before = await lastNoteId(t3);
    const d = ok(await t3.call('POST', `/v1/staff/requests/${r.request.id}/accept`, { reply: 'Happy to' }));
    expect(d.request).toMatchObject({ status: 'accepted', reply: 'Happy to' });
    expect(await substituteOf(s.id)).toEqual({ substitute_id: t3Id, change_note: 'Dr. Sen covers chapter 4' });

    const studentNote = (await newNotes(aarav, aaravBefore))[0]!;
    expect(studentNote.title).toBe('Different teacher · CS-301');
    expect(studentNote.body).toContain('will be taken by Dr. Sen — “Dr. Sen covers chapter 4”');
    const back = (await newNotes(admin, adminBefore)).find((n) => n.data.requestId === r.request.id)!;
    expect(back.title).toBe('Dr. Sen will take CS-301');
    expect(back.body).toContain('“Happy to”');
    // The teacher who accepted isn't told about their own decision.
    expect((await newNotes(t3, t3Before)).length).toBe(0);
    // The student sees the note on the class itself.
    const tt = ok(await aarav.call('GET', '/v1/me/timetable'));
    expect(tt.upcoming.find((x: { sessionId?: string; id?: string }) => (x.sessionId ?? x.id) === s.id)?.change).toMatchObject({ kind: 'substitute', note: 'Dr. Sen covers chapter 4', teacher: 'Dr. Sen' });
    // The substitute now sees the class on their day.
    expect(ok(await t3.call('GET', `/v1/staff/sessions?date=${s.ymd}`)).map((x: { id: string }) => x.id)).toContain(s.id);
  });

  it('refuses a teacher who is busy then, and says why', async () => {
    const s = await scheduled(seed.courseId, 3, '10:00');
    await scheduled(seed.otherCourseId, 3, '10:30'); // Rao teaches 10:30–11:30
    const r = ok(await admin.call('POST', '/v1/staff/cover-requests', { sessionId: s.id, teacherId: t2Id }));
    expect(r.status).toBe('refused');
    expect(r.conflicts[0]).toMatchObject({ kind: 'teacher', severity: 'error' });
    expect(ok(await t2.call('GET', '/v1/staff/requests')).incoming.some((x: { session: { id: string } }) => x.session.id === s.id)).toBe(false);
  });

  it('a decline tells the requester and changes nothing; a new request replaces the old one', async () => {
    const s = await scheduled(seed.courseId, 4, '09:00');
    const first = ok(await admin.call('POST', '/v1/staff/cover-requests', { sessionId: s.id, teacherId: t3Id, noteToTeacher: 'Kumar has a doctor’s appointment' }));
    expect(first.status).toBe('sent');
    const t3Before = await lastNoteId(t3);
    const second = ok(await admin.call('POST', '/v1/staff/cover-requests', { sessionId: s.id, teacherId: t2Id }));
    expect(second.status).toBe('sent');
    const withdrawn = (await newNotes(t3, t3Before))[0]!;
    expect(withdrawn.title).toBe('Request withdrawn · CS-301');
    expect((await t3.call('POST', `/v1/staff/requests/${first.request.id}/accept`, {})).statusCode).toBe(409);

    const adminBefore = await lastNoteId(admin);
    ok(await t2.call('POST', `/v1/staff/requests/${second.request.id}/decline`, { reply: 'I have a lab then' }));
    expect((await substituteOf(s.id)).substitute_id).toBeNull();
    const told = (await newNotes(admin, adminBefore))[0]!;
    expect(told.title).toBe('Dr. Rao can’t take CS-301');
    expect(told.body).toContain('“I have a lab then”');
  });

  it('only admins hand classes out — teachers, even for their own class, can only answer', async () => {
    const s = await scheduled(seed.courseId, 5, '09:00');
    for (const d of [t1, t2]) {
      const r = await d.call('POST', '/v1/staff/cover-requests', { sessionId: s.id, teacherId: t3Id });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.message).toContain('Only an admin');
    }
    // …not through "adjust" either.
    const adj = ok(await t1.call('POST', `/v1/staff/sessions/${s.id}/adjust`, { change: { op: 'substitute', sessionId: s.id, teacherId: t3Id } }));
    expect(adj.published).toBe(false);
    expect(adj.errors[0].message).toContain('Only an admin');
    const r = ok(await admin.call('POST', '/v1/staff/cover-requests', { sessionId: s.id, teacherId: t3Id }));
    expect((await t3.call('POST', `/v1/staff/requests/${r.request.id}/cancel`)).statusCode).toBe(403);
    const t3Before = await lastNoteId(t3);
    expect(ok(await admin.call('POST', `/v1/staff/requests/${r.request.id}/cancel`)).status).toBe('cancelled');
    expect((await newNotes(t3, t3Before))[0]!.title).toBe('Request withdrawn · CS-301');
  });

  it('taking a class yourself needs no approval; an over or cancelled class can’t be handed over', async () => {
    const s = await scheduled(seed.courseId, 6, '09:00');
    const r = ok(await admin.call('POST', '/v1/staff/cover-requests', { sessionId: s.id, teacherId: adminId, noteToStudents: 'Principal’s special lecture' }));
    expect(r.status).toBe('applied');
    expect(await substituteOf(s.id)).toEqual({ substitute_id: adminId, change_note: 'Principal’s special lecture' });

    const p = await scheduled(seed.courseId, 1, '15:00');
    const req = ok(await admin.call('POST', '/v1/staff/cover-requests', { sessionId: p.id, teacherId: t3Id }));
    await ctx.db.query(`update class_sessions set status = 'cancelled' where id = $1`, [p.id]);
    const late = await t3.call('POST', `/v1/staff/requests/${req.request.id}/accept`, {});
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toContain('expired');
    expect((await admin.call('POST', '/v1/staff/cover-requests', { sessionId: p.id, teacherId: t3Id })).statusCode).toBe(409);
  });

  it('a substitution in a planner draft becomes a request when published', async () => {
    const s = await scheduled(seed.courseId, 8, '11:00');
    const week = ok(await admin.call('GET', `/v1/staff/planner?week=${s.ymd}`));
    const d = ok(await admin.call('POST', '/v1/staff/drafts', { weekStart: week.weekStart, title: 'Cover week' }));
    const ops = [{ op: 'substitute', sessionId: s.id, teacherId: t3Id, noteToTeacher: 'Can you cover?', noteToStudents: 'Guest lecture' }];
    const saved = ok(await admin.call('POST', `/v1/staff/drafts/${d.id}`, { version: d.version, ops }));
    expect(ok(await admin.call('POST', `/v1/staff/drafts/${d.id}/check`)).requested).toBe(1);
    const pub = ok(await admin.call('POST', `/v1/staff/drafts/${d.id}/publish`, { version: saved.version }));
    expect(pub).toMatchObject({ published: true, requested: 1, applied: 0 });
    expect((await substituteOf(s.id)).substitute_id).toBeNull();
    const req = ok(await t3.call('GET', '/v1/staff/requests')).incoming.find((x: { session: { id: string } }) => x.session.id === s.id);
    expect(req).toMatchObject({ status: 'pending', noteToTeacher: 'Can you cover?', noteToStudents: 'Guest lecture' });
  });
});

describe('students asking their teacher', () => {
  it('reaches the class’s teacher, who replies; the student is told', async () => {
    const s = await scheduled(seed.courseId, 9, '10:00');
    const t1Before = await lastNoteId(t1);
    const r = ok(await aarav.call('POST', '/v1/me/requests', { sessionId: s.id, topic: 'reschedule', note: 'We have a lab exam at that time' }));
    expect(r).toMatchObject({ kind: 'student', topic: 'reschedule', status: 'pending', to: { id: t1Id } });
    const asked = (await newNotes(t1, t1Before))[0]!;
    expect(asked.title).toContain('Please move this class');
    expect(asked.body).toContain('“We have a lab exam at that time”');
    // One open question per class.
    expect((await aarav.call('POST', '/v1/me/requests', { sessionId: s.id, topic: 'other', note: 'again' })).statusCode).toBe(409);
    // Someone else's teacher can't answer it.
    expect((await t2.call('POST', `/v1/staff/requests/${r.id}/accept`, {})).statusCode).toBe(403);

    const aaravBefore = await lastNoteId(aarav);
    ok(await t1.call('POST', `/v1/staff/requests/${r.id}/accept`, { reply: 'Moving it to Friday' }));
    const reply = (await newNotes(aarav, aaravBefore))[0]!;
    expect(reply.title).toBe('Dr. Kumar replied · CS-301');
    expect(reply.body).toContain('“Moving it to Friday”');
    expect(ok(await aarav.call('GET', '/v1/me/requests')).outgoing[0]).toMatchObject({ id: r.id, status: 'accepted', reply: 'Moving it to Friday' });
  });

  it('only for their own courses, and a few open requests at a time', async () => {
    const other = await scheduled(seed.otherCourseId, 9, '12:00'); // aarav isn't in MA-202
    expect((await aarav.call('POST', '/v1/me/requests', { sessionId: other.id, topic: 'doubt', note: 'hello there' })).statusCode).toBe(404);
    expect((await aarav.call('POST', '/v1/me/requests', { sessionId: other.id, topic: 'doubt', note: 'x' })).statusCode).toBe(400);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await scheduled(seed.courseId, 10 + i, '10:00');
      const r = await priya.call('POST', '/v1/me/requests', { sessionId: s.id, topic: 'extra', note: `Extra class please ${i}` });
      if (r.statusCode === 200) ids.push(r.json().id);
    }
    const s = await scheduled(seed.courseId, 16, '10:00');
    expect((await priya.call('POST', '/v1/me/requests', { sessionId: s.id, topic: 'extra', note: 'one more please' })).statusCode).toBe(429);
    ok(await priya.call('POST', `/v1/me/requests/${ids[0]}/cancel`));
    expect((await priya.call('POST', '/v1/me/requests', { sessionId: s.id, topic: 'extra', note: 'one more please' })).statusCode).toBe(200);
    // Staff routes are closed to students and vice versa.
    expect((await priya.call('POST', '/v1/staff/cover-requests', { sessionId: s.id, teacherId: t3Id })).statusCode).toBe(403);
    expect((await t1.call('POST', '/v1/me/requests', { sessionId: s.id, topic: 'extra', note: 'staff cannot' })).statusCode).toBe(403);
  });

  it('every step is in the tamper-evident audit log', async () => {
    const actions = (await ctx.db.query<{ action: string }>(`select distinct action from audit_log where action like 'cover.%' or action like 'student.%'`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['cover.request', 'cover.accept', 'cover.decline', 'cover.cancel', 'student.request', 'student.accept']));
    expect((await verifyAuditChain(ctx.db)).ok).toBe(true);
  });
});
