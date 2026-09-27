import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDaysYmd, weekdayOf } from '@attendly/protocol';
import { createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';
import { verifyAuditChain } from '../src/lib/audit';
import { materializeTimetable } from '../src/lib/timetable';

let ctx: TestCtx;
let seed: Seeded;
let admin: TestDevice;
let t1: TestDevice; // teaches CS-301 (aarav + priya)
let t2: TestDevice; // teaches MA-202 (priya)
let aarav: TestDevice;
let priya: TestDevice;
let t1Id: string;
let t2Id: string;
let r1: string;
let r2: string;

const IST = 5.5 * 3_600_000;
const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const localToday = () => new Date(ctx.clock.now + IST).toISOString().slice(0, 10);
/** UTC instant of a Kolkata wall-clock time. */
const istUtc = (ymd: string, hm: string) => Date.parse(`${ymd}T${hm}:00Z`) - IST;

/** A scheduled class of a course, `daysAhead` days from today at hh:mm (Kolkata). */
async function scheduled(courseId: string, daysAhead: number, hm: string, roomId: string | null = r1) {
  const ymd = addDaysYmd(localToday(), daysAhead);
  const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId, status: 'scheduled', startedAt: istUtc(ymd, hm) });
  await ctx.db.query('update class_sessions set room_id = $2, room = (select name from rooms where id = $2) where id = $1', [s.id, roomId]);
  return { ...s, ymd };
}
const notificationsOf = async (d: TestDevice) => ok(await d.call('GET', '/v1/notifications')) as { items: { title: string; body: string; read: boolean; id: number }[]; unread: number };

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  const mk = async (role: string, email: string) =>
    (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, $2, $3, $4) returning id`, [seed.tenantId, role, email.split('@')[0], email])).rows[0]!.id;
  await mk('admin', 'hod@iit.ac.in');
  t1Id = await mk('teacher', 'kumar@iit.ac.in');
  t2Id = await mk('teacher', 'rao@iit.ac.in');
  await ctx.db.query('update courses set instructor_id = $1 where id = $2', [t1Id, seed.courseId]);
  await ctx.db.query('update courses set instructor_id = $1 where id = $2', [t2Id, seed.otherCourseId]);
  const room = async (name: string) => (await ctx.db.query<{ id: string }>(`insert into rooms(tenant_id, name, lat, lng) values ($1, $2, 28.5, 77.1) returning id`, [seed.tenantId, name])).rows[0]!.id;
  r1 = await room('LH-1');
  r2 = await room('LH-2');
  admin = new TestDevice(ctx);
  t1 = new TestDevice(ctx);
  t2 = new TestDevice(ctx);
  aarav = new TestDevice(ctx);
  priya = new TestDevice(ctx);
  await admin.signIn('hod@iit.ac.in');
  await t1.signIn('kumar@iit.ac.in');
  await t2.signIn('rao@iit.ac.in');
  await aarav.signIn('aarav@iit.ac.in');
  await priya.signIn('priya@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('batches', () => {
  it('attaching a batch enrolls its members; detaching or leaving removes only batch enrollments', async () => {
    // (Teachers may create batches too — see batches.test.ts.)
    const b = ok(await admin.call('POST', '/v1/staff/batches', { name: 'CSE-A' }));
    expect((await admin.call('POST', '/v1/staff/batches', { name: 'CSE-A' })).statusCode).toBe(409);

    const d = ok(await admin.call('POST', `/v1/staff/batches/${b.id}`, { addMembers: [seed.studentId], courseIds: [seed.otherCourseId] }));
    expect(d).toMatchObject({ size: 1, courseIds: [seed.otherCourseId] });
    const enrolled = async () => (await ctx.db.query<{ course_id: string; batch_id: string | null }>('select course_id, batch_id from enrollments where user_id = $1 order by course_id', [seed.studentId])).rows;
    expect(await enrolled()).toContainEqual({ course_id: seed.otherCourseId, batch_id: b.id });

    // Can't be removed from the course directly while their batch takes it.
    const direct = await admin.call('POST', `/v1/staff/courses/${seed.otherCourseId}/enrollments`, { remove: [seed.studentId] });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().error.message).toContain('through their batch');

    ok(await admin.call('POST', `/v1/staff/batches/${b.id}`, { removeMembers: [seed.studentId] }));
    const after = await enrolled();
    expect(after.some((e) => e.course_id === seed.otherCourseId)).toBe(false);
    expect(after).toContainEqual({ course_id: seed.courseId, batch_id: null }); // direct enrollment untouched

    // Importing students straight into a batch enrolls them in the batch's courses.
    ok(await admin.call('POST', `/v1/staff/batches/${b.id}`, { courseIds: [seed.otherCourseId, seed.courseId] }));
    const imp = ok(await admin.call('POST', '/v1/staff/people/import', { rows: [{ fullName: 'Nisha Rao', email: 'nisha@iit.ac.in', rollNo: 'N1' }], batchId: b.id }));
    expect(imp.created).toBe(1);
    const list = ok(await admin.call('GET', `/v1/staff/batches/${b.id}`));
    expect(list.members.map((m: { fullName: string }) => m.fullName)).toEqual(['Nisha Rao']);
    const n = await ctx.db.query('select 1 from enrollments e join users u on u.id = e.user_id where u.email = $1', ['nisha@iit.ac.in']);
    expect(n.rowCount).toBe(2);
    ok(await admin.call('POST', `/v1/staff/batches/${b.id}`, { courseIds: [] }));
  });
});

describe('one-off adjustments by a teacher', () => {
  it('reschedules their own class and tells exactly its students', async () => {
    const s = await scheduled(seed.courseId, 2, '10:00');
    const to = addDaysYmd(s.ymd, 1);
    const r = ok(await t1.call('POST', `/v1/staff/sessions/${s.id}/adjust`, { change: { op: 'reschedule', sessionId: s.id, date: to, start: '14:00', end: '15:00', roomId: r2 } }));
    expect(r).toMatchObject({ published: true, applied: 1, conflicts: [], errors: [] });
    const row = (await ctx.db.query<{ scheduled_start: Date; original_start: Date; change_kind: string; room_id: string; slot_date: string | null }>('select * from class_sessions where id = $1', [s.id])).rows[0]!;
    expect(row.scheduled_start.getTime()).toBe(istUtc(to, '14:00'));
    expect(row.original_start.getTime()).toBe(istUtc(s.ymd, '10:00'));
    expect(row).toMatchObject({ change_kind: 'rescheduled', room_id: r2 });

    const na = await notificationsOf(aarav);
    expect(na.unread).toBe(1);
    expect(na.items[0]!.title).toBe('Class moved · CS-301');
    expect(na.items[0]!.body).toMatch(/CS-301 moved: .* 10:00 AM → .* 2:00 PM · LH-2/);
    expect((await notificationsOf(priya)).unread).toBe(1);
    // The teacher who made the change isn't notified of their own change.
    expect((await notificationsOf(t1)).unread).toBe(0);
    // Students see it on their timetable too.
    const tt = ok(await aarav.call('GET', '/v1/me/timetable'));
    expect(tt.upcoming.find((u: { sessionId: string }) => u.sessionId === s.id).change).toMatchObject({ kind: 'rescheduled' });

    ok(await aarav.call('POST', '/v1/notifications/read', { all: true }));
    expect((await notificationsOf(aarav)).unread).toBe(0);
    ok(await priya.call('POST', '/v1/notifications/read', { ids: [(await notificationsOf(priya)).items[0]!.id] }));
    expect((await notificationsOf(priya)).unread).toBe(0);
  });

  it('refuses clashes: nothing changes, nobody is notified', async () => {
    const mine = await scheduled(seed.courseId, 3, '09:00', r1);
    const other = await scheduled(seed.otherCourseId, 3, '11:00', r2);
    // Into MA-202's room at the same time → room error.
    const room = ok(await t1.call('POST', `/v1/staff/sessions/${mine.id}/adjust`, { change: { op: 'reschedule', sessionId: mine.id, date: other.ymd, start: '11:00', end: '12:00', roomId: r2 } }));
    expect(room.published).toBe(false);
    expect(room.conflicts.map((c: { kind: string }) => c.kind)).toContain('room');
    // Different room, same time → priya has both: a warning that must be accepted knowingly.
    const change = { op: 'reschedule', sessionId: mine.id, date: other.ymd, start: '11:00', end: '12:00', roomId: r1 };
    const warn = ok(await t1.call('POST', `/v1/staff/sessions/${mine.id}/adjust`, { change }));
    expect(warn).toMatchObject({ published: false, conflicts: [{ kind: 'students', severity: 'warning' }] });
    expect((await ctx.db.query<{ change_kind: string | null }>('select change_kind from class_sessions where id = $1', [mine.id])).rows[0]!.change_kind).toBeNull();
    expect((await notificationsOf(priya)).unread).toBe(0);
    expect(ok(await t1.call('POST', `/v1/staff/sessions/${mine.id}/adjust`, { change, acceptWarnings: true })).published).toBe(true);
  });

  it('teachers act only on their own classes and never on the weekly timetable', async () => {
    const theirs = await scheduled(seed.otherCourseId, 4, '09:00');
    expect((await t1.call('POST', `/v1/staff/sessions/${theirs.id}/adjust`, { change: { op: 'cancel', sessionId: theirs.id, reason: 'not mine' } })).statusCode).toBe(404);
    const bad = await t1.call('POST', `/v1/staff/sessions/${theirs.id}/adjust`, { change: { op: 'slot.delete', slotId: theirs.id } });
    expect(bad.statusCode).toBe(400);
    expect((await t1.call('POST', '/v1/staff/drafts', { title: 'x', weekStart: localToday() })).statusCode).toBe(403);
    expect((await t1.call('GET', '/v1/staff/planner')).statusCode).toBe(403);
  });

  it('a substitute must be free; once assigned they can run the class and are told', async () => {
    const s = await scheduled(seed.courseId, 5, '10:00', r1);
    await scheduled(seed.otherCourseId, 5, '10:30', r2); // Rao is busy 10:30–11:30
    const busy = ok(await admin.call('POST', `/v1/staff/sessions/${s.id}/adjust`, { change: { op: 'substitute', sessionId: s.id, teacherId: t2Id } }));
    expect(busy).toMatchObject({ published: false, conflicts: [{ kind: 'teacher', severity: 'error' }] });

    const free = await scheduled(seed.courseId, 6, '10:00', r1);
    // Handing it over is a request: nothing changes until Rao accepts.
    expect(ok(await admin.call('POST', `/v1/staff/sessions/${free.id}/adjust`, { change: { op: 'substitute', sessionId: free.id, teacherId: t2Id } }))).toMatchObject({ published: true, requested: 1, applied: 0 });
    const n = await notificationsOf(t2);
    expect(n.items[0]!.title).toBe('Can you take CS-301?');
    expect(ok(await t1.call("GET", `/v1/staff/sessions/${free.id}`)).session.substitute).toBeNull();
    const req = ok(await t2.call('GET', '/v1/staff/requests')).incoming.find((r: { session: { id: string } }) => r.session.id === free.id);
    expect(ok(await t2.call('POST', `/v1/staff/requests/${req.id}/accept`, {})).request.status).toBe('accepted');
    expect(ok(await t2.call('GET', `/v1/staff/sessions/${free.id}`)).session).toMatchObject({ substitute: { id: t2Id }, change: { kind: 'substitute' } });
    const theirList = ok(await t2.call('GET', `/v1/staff/sessions?date=${free.ymd}`));
    expect(theirList.map((x: { id: string }) => x.id)).toContain(free.id);
    // A substitute runs the class but can't reorganise it.
    expect(ok(await t2.call('POST', `/v1/staff/sessions/${free.id}/adjust`, { change: { op: 'cancel', sessionId: free.id, reason: 'I can’t' } })).errors[0].message).toContain('own teacher');
    const avail = ok(await admin.call('GET', `/v1/staff/availability?date=${free.ymd}`));
    expect(avail.teachers.find((t: { id: string }) => t.id === t2Id).busy.some((b: { sessionId: string; substitute: boolean }) => b.sessionId === free.id && b.substitute)).toBe(true);
  });

  it('cancelling with a reason tells students why; a class with attendance can’t be cancelled', async () => {
    const s = await scheduled(seed.courseId, 7, '12:00');
    const before = (await notificationsOf(aarav)).items.length;
    ok(await t1.call('POST', `/v1/staff/sessions/${s.id}/cancel`, { reason: 'Faculty meeting' }));
    const n = await notificationsOf(aarav);
    expect(n.items.length).toBe(before + 1);
    expect(n.items[0]!.body).toContain('cancelled — Faculty meeting');
  });
});

describe('background notification check (device key only)', () => {
  const poll = (d: TestDevice, url: string, key = d.publicKeyB64) =>
    ctx.app.inject({ method: 'GET', url, headers: { ...d.signedHeaders('GET', url, ''), 'x-attendly-key': key } });

  it('returns new unread notifications without any login token', async () => {
    const r = await poll(aarav, '/v1/notifications/poll?after=0');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.unread).toBeGreaterThan(0);
    const last = body.items.at(-1).id;
    expect((await poll(aarav, `/v1/notifications/poll?after=${last}`)).json().items.every((i: { id: number }) => i.id > last)).toBe(true);
  });

  it('refuses a key that isn’t this phone’s, a bad signature, and a signed-out phone', async () => {
    expect((await poll(aarav, '/v1/notifications/poll', priya.publicKeyB64)).statusCode).toBe(401);
    const url = '/v1/notifications/poll';
    const forged = await ctx.app.inject({ method: 'GET', url, headers: { ...aarav.signedHeaders('GET', url, '', { key: priya.keys.secretKey }), 'x-attendly-key': aarav.publicKeyB64 } });
    expect(forged.statusCode).toBe(401);
    ok(await priya.call('POST', '/v1/auth/logout', {}));
    expect((await poll(priya, url)).statusCode).toBe(401);
  });
});

describe('the admin planner: drafts → publish', () => {
  it('saves drafts with version checks, validates, publishes weekly moves, keeps one-off changes', async () => {
    // A weekly slot two days ahead, with its classes generated.
    const day = addDaysYmd(localToday(), 2);
    const slot = ok(await admin.call('POST', '/v1/staff/timetable', { courseId: seed.courseId, weekday: weekdayOf(day), start: '08:00', end: '09:00', roomId: r1 }));
    const occ = (await ctx.db.query<{ id: string; slot_date: string }>(`select id, to_char(slot_date, 'YYYY-MM-DD') as slot_date from class_sessions where slot_id = $1 order by scheduled_start`, [slot.id])).rows;
    expect(occ.length).toBeGreaterThanOrEqual(2);
    // Next week's occurrence is moved one-off first.
    const nextWeek = occ[1]!;
    ok(await admin.call('POST', `/v1/staff/sessions/${nextWeek.id}/adjust`, { change: { op: 'reschedule', sessionId: nextWeek.id, date: nextWeek.slot_date, start: '16:00', end: '17:00' } }));

    const week = ok(await admin.call('GET', `/v1/staff/planner?week=${day}`));
    expect(week.items.some((i: { slotId: string }) => i.slotId === slot.id)).toBe(true);
    // Students appear only as anonymous numbers.
    expect(JSON.stringify(week)).not.toContain(seed.studentId);

    const draft = ok(await admin.call('POST', '/v1/staff/drafts', { title: 'Week 5 changes', weekStart: day }));
    const newDay = addDaysYmd(day, 1);
    const ops = [{ op: 'slot.update', slotId: slot.id, weekday: weekdayOf(newDay), start: '15:00', end: '16:00' }];
    const saved = ok(await admin.call('POST', `/v1/staff/drafts/${draft.id}`, { version: draft.version, ops }));
    expect(saved).toMatchObject({ version: draft.version + 1, weekly: 1, once: 0 });
    expect((await admin.call('POST', `/v1/staff/drafts/${draft.id}`, { version: draft.version, ops: [] })).statusCode).toBe(409);
    expect(ok(await admin.call('POST', `/v1/staff/drafts/${draft.id}/check`, {}))).toMatchObject({ published: false, errors: [] });
    expect((await admin.call('POST', `/v1/staff/drafts/${draft.id}/publish`, { version: draft.version })).statusCode).toBe(409);

    const pub = ok(await admin.call('POST', `/v1/staff/drafts/${draft.id}/publish`, { version: saved.version }));
    expect(pub).toMatchObject({ published: true, applied: 1 });
    expect(pub.notified).toBeGreaterThanOrEqual(2);
    expect((await admin.call('POST', `/v1/staff/drafts/${draft.id}/publish`, { version: saved.version })).statusCode).toBe(409);

    const after = (await ctx.db.query<{ id: string; start: string; change_kind: string | null }>(
      `select id, to_char(scheduled_start at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as start, change_kind from class_sessions where slot_id = $1 and status = 'scheduled' order by scheduled_start`,
      [slot.id],
    )).rows;
    expect(after.find((r) => r.id === nextWeek.id)).toMatchObject({ change_kind: 'rescheduled' }); // one-off kept
    expect(after.filter((r) => !r.change_kind).every((r) => r.start.endsWith('15:00') && weekdayOf(r.start.slice(0, 10)) === weekdayOf(newDay))).toBe(true);
    // Re-running the timetable never duplicates a class for a day that already has one.
    await materializeTimetable(ctx.db, { slotId: slot.id });
    const perDay = await ctx.db.query(`select slot_date, count(*) from class_sessions where slot_id = $1 group by slot_date having count(*) > 1`, [slot.id]);
    expect(perDay.rowCount).toBe(0);

    const n = await notificationsOf(aarav);
    expect(n.items[0]!.body).toContain('weekly class');
  });

  it('refuses a draft that double-books a room or teacher, and discards cleanly', async () => {
    const a = await scheduled(seed.courseId, 8, '10:00', r1);
    const b = await scheduled(seed.otherCourseId, 8, '12:00', r2);
    const draft = ok(await admin.call('POST', '/v1/staff/drafts', { title: 'Clash', weekStart: a.ymd }));
    const ops = [
      { op: 'reschedule', sessionId: b.id, date: a.ymd, start: '10:00', end: '11:00', roomId: r1 },
      { op: 'extra', tempId: 'extra1', courseId: seed.courseId, date: a.ymd, start: '10:30', end: '11:30', roomId: r2 },
    ];
    const saved = ok(await admin.call('POST', `/v1/staff/drafts/${draft.id}`, { version: draft.version, ops }));
    const r = ok(await admin.call('POST', `/v1/staff/drafts/${draft.id}/publish`, { version: saved.version, acceptWarnings: true }));
    expect(r.published).toBe(false);
    expect(r.conflicts.map((c: { kind: string }) => c.kind).sort()).toEqual(expect.arrayContaining(['room', 'teacher']));
    expect((await ctx.db.query<{ change_kind: string | null }>('select change_kind from class_sessions where id = $1', [b.id])).rows[0]!.change_kind).toBeNull();
    expect(ok(await admin.call('POST', `/v1/staff/drafts/${draft.id}/discard`, {})).status).toBe('discarded');
    const list = ok(await admin.call('GET', '/v1/staff/drafts'));
    expect(list.find((d: { id: string }) => d.id === draft.id).status).toBe('discarded');
  });

  it('keeps the audit chain intact', async () => {
    expect((await verifyAuditChain(ctx.db)).ok).toBe(true);
    const actions = (await ctx.db.query<{ action: string }>(`select distinct action from audit_log`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['timetable.publish', 'batch.create', 'batch.update']));
  });
});
