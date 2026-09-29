import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  CourseReport,
  MarkPresent,
  OfflinePack,
  Overview,
  Person,
  SessionFeed,
  SessionWithSecret,
  Slot,
  StaffSession,
  SubjectDetailResponse,
  TimetableResponse,
  currentQrSeq,
  encodeQrToken,
  fromB64url,
} from '@attendly/protocol';
import { at, createTestApp, seedBasic, TestDevice, CENTER, type Seeded, type TestCtx } from './harness';
import { bootstrapInstitution } from '../src/bootstrap';
import { verifyAuditChain } from '../src/lib/audit';
import { STAFF_LOGIN_MAX_MS } from '../src/lib/auth';

let ctx: TestCtx;
let seed: Seeded;
let admin: TestDevice;
let teacher: TestDevice;
let otherTeacher: TestDevice;
let student: TestDevice;
let teacherId: string;
let otherTeacherId: string;
let studentId: string;
let courseId: string;
let roomId: string;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const code = (r: { json(): any }) => r.json().error?.code;

function loc(extra: Record<string, unknown> = {}) {
  return { ...at(5), accuracyM: 8, mocked: false, capturedAt: ctx.clock.now, ...extra };
}

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  const mk = async (role: string, email: string) =>
    (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, $2, $3, $4) returning id`, [seed.tenantId, role, email.split('@')[0], email]))
      .rows[0]!.id;
  await mk('admin', 'head@iit.ac.in');
  teacherId = await mk('teacher', 'teach@iit.ac.in');
  otherTeacherId = await mk('teacher', 'other@iit.ac.in');
  admin = new TestDevice(ctx);
  teacher = new TestDevice(ctx);
  otherTeacher = new TestDevice(ctx);
  student = new TestDevice(ctx);
  await admin.signIn('head@iit.ac.in');
  await teacher.signIn('teach@iit.ac.in');
  await otherTeacher.signIn('other@iit.ac.in');
  await student.signIn('aarav@iit.ac.in');
  studentId = seed.studentId;
});
afterAll(async () => ctx?.close());

describe('roles and scoping', () => {
  it('students cannot use any staff endpoint', async () => {
    for (const url of ['/v1/staff/me', '/v1/staff/overview', '/v1/staff/courses', '/v1/staff/people'])
      expect((await student.call('GET', url)).statusCode).toBe(403);
  });

  it('teachers cannot use admin-only endpoints', async () => {
    expect(code(await teacher.call('POST', '/v1/staff/rooms', { name: 'X' }))).toBe('FORBIDDEN');
    expect(code(await teacher.call('POST', '/v1/staff/people', { role: 'student', fullName: 'Y', email: 'y@iit.ac.in' }))).toBe('FORBIDDEN');
    expect(code(await teacher.call('GET', '/v1/staff/people?role=staff'))).toBe('FORBIDDEN');
    expect(code(await teacher.call('GET', '/v1/staff/device-requests'))).toBe('FORBIDDEN');
    expect(code(await teacher.call('POST', '/v1/staff/institution', { minAttendance: 50 }))).toBe('FORBIDDEN');
  });

  it('staff logins expire within a working day, however often they refresh', async () => {
    const { rows } = await ctx.db.query<{ span: number }>(
      `select extract(epoch from (s.family_expires_at - s.created_at)) * 1000 as span from auth_sessions s join users u on u.id = s.user_id
        where u.email = 'teach@iit.ac.in' order by s.created_at desc limit 1`,
    );
    expect(Number(rows[0]!.span)).toBeLessThanOrEqual(STAFF_LOGIN_MAX_MS + 1000);
  });
});

describe('setting up an institution', () => {
  it('admin creates a room, a course with a teacher, people and enrollments', async () => {
    const room = ok(await admin.call('POST', '/v1/staff/rooms', { name: 'LH-9', lat: CENTER.lat, lng: CENTER.lng, radiusM: 60 }));
    roomId = room.id;
    expect(code(await admin.call('POST', '/v1/staff/rooms', { name: 'LH-9' }))).toBe('CONFLICT');
    expect(code(await admin.call('POST', '/v1/staff/rooms', { name: 'Half', lat: 10 }))).toBe('BAD_REQUEST');

    const course = ok(await admin.call('POST', '/v1/staff/courses', { code: 'os-401', title: 'Advanced OS', instructorId: teacherId }));
    courseId = course.id;
    expect(course.code).toBe('OS-401');
    expect(code(await admin.call('POST', '/v1/staff/courses', { code: 'OS-401', title: 'Dup' }))).toBe('CONFLICT');
    expect(code(await admin.call('POST', '/v1/staff/courses', { code: 'Z-1', title: 'Bad', instructorId: studentId }))).toBe('BAD_REQUEST');

    const p = Person.parse(ok(await admin.call('POST', '/v1/staff/people', { role: 'student', fullName: 'New Kid', email: 'kid@gmail.com', rollNo: 'R-77', courseIds: [courseId] })));
    expect(p.courseIds).toEqual([courseId]);
    expect(code(await admin.call('POST', '/v1/staff/people', { role: 'student', fullName: 'Dup', email: 'kid@gmail.com' }))).toBe('CONFLICT');
    expect(code(await admin.call('POST', '/v1/staff/people', { role: 'student', fullName: 'Nobody' }))).toBe('BAD_REQUEST');

    const imp = ok(
      await admin.call('POST', '/v1/staff/people/import', {
        rows: [{ fullName: 'Bulk One', email: 'b1@iit.ac.in', rollNo: 'B1' }, { fullName: 'No Contact' }, { fullName: 'Bulk Dup', email: 'kid@gmail.com' }],
        courseIds: [courseId],
      }),
    );
    expect(imp.created).toBe(1);
    expect(imp.skipped.map((x: { row: number }) => x.row)).toEqual([2, 3]);

    const roster = ok(await admin.call('POST', `/v1/staff/courses/${courseId}/enrollments`, { add: [studentId] }));
    expect(roster.map((r: { fullName: string }) => r.fullName).sort()).toEqual(['Bulk One', 'New Kid', 'aarav']);
    expect(code(await admin.call('POST', `/v1/staff/courses/${courseId}/enrollments`, { add: [teacherId] }))).toBe('BAD_REQUEST');

    // A student registered with a personal email (any domain) can sign in.
    const kid = new TestDevice(ctx);
    await kid.signIn('kid@gmail.com');
    expect((await kid.call('GET', '/v1/me/dashboard')).statusCode).toBe(200);
  });

  it('teachers only see their own courses; others get 404', async () => {
    const mine = ok(await teacher.call('GET', '/v1/staff/courses'));
    expect(mine.map((c: { id: string }) => c.id)).toEqual([courseId]);
    expect(ok(await otherTeacher.call('GET', '/v1/staff/courses'))).toEqual([]);
    expect(code(await otherTeacher.call('GET', `/v1/staff/courses/${courseId}/roster`))).toBe('NOT_FOUND');
    expect(code(await otherTeacher.call('GET', `/v1/staff/courses/${courseId}/report`))).toBe('NOT_FOUND');
    // A teacher can see only students of their courses.
    const people = ok(await teacher.call('GET', '/v1/staff/people?role=student'));
    expect(people.map((p: { fullName: string }) => p.fullName).sort()).toEqual(['Bulk One', 'New Kid', 'aarav']);
    expect(ok(await otherTeacher.call('GET', '/v1/staff/people?role=student'))).toEqual([]);
  });

  it('a weekly slot generates classes that everyone sees', async () => {
    const weekday = new Date(ctx.clock.now + 5.5 * 3_600_000).getUTCDay(); // today in Asia/Kolkata
    const slot = Slot.parse(ok(await admin.call('POST', '/v1/staff/timetable', { courseId, weekday, start: '00:00', end: '23:59', roomId })));
    expect(slot.room?.name).toBe('LH-9');
    // Double-booking the room is refused.
    expect(code(await admin.call('POST', '/v1/staff/timetable', { courseId, weekday, start: '10:00', end: '11:00', roomId }))).toBe('CONFLICT');
    expect(code(await admin.call('POST', '/v1/staff/timetable', { courseId, weekday, start: '11:00', end: '10:00' }))).toBe('BAD_REQUEST');

    const sessions = StaffSession.array().parse(ok(await teacher.call('GET', '/v1/staff/sessions')));
    const today = sessions.find((s) => s.courseId === courseId);
    expect(today).toMatchObject({ status: 'scheduled', mode: 'qr', lat: CENTER.lat, radiusM: 60 });

    const tt = TimetableResponse.parse(ok(await student.call('GET', '/v1/me/timetable')));
    expect(tt.slots.find((s) => s.courseId === courseId)).toMatchObject({ weekday, start: '00:00', room: 'LH-9' });
    expect(tt.upcoming.some((u) => u.courseId === courseId)).toBe(true);

    const ov = Overview.parse(ok(await teacher.call('GET', '/v1/staff/overview')));
    expect(ov.role).toBe('teacher');
    expect(ov.today.map((s) => s.courseId)).toContain(courseId);
  });
});

describe('running a class', () => {
  let sessionId: string;
  let secret: Uint8Array;

  it('offline pack gives the teacher secrets and rosters for today', async () => {
    const pack = OfflinePack.parse(ok(await teacher.call('GET', '/v1/staff/offline-pack')));
    const s = pack.sessions.find((x) => x.courseId === courseId)!;
    expect(s.secret).toBeTruthy();
    expect(pack.rosters[courseId]!.length).toBe(3);
    sessionId = s.id;
    secret = fromB64url(s.secret!);
    // Another teacher gets nothing of it.
    const other = OfflinePack.parse(ok(await otherTeacher.call('GET', '/v1/staff/offline-pack')));
    expect(other.sessions.find((x) => x.id === sessionId)).toBeUndefined();
    expect(code(await otherTeacher.call('GET', `/v1/staff/sessions/${sessionId}`))).toBe('NOT_FOUND');
  });

  it('a QR shown by an OFFLINE teacher phone works: the first valid scan takes the class live', async () => {
    const qr = encodeQrToken(secret, sessionId, currentQrSeq(ctx.clock.now, 5));
    const res = MarkPresent.parse(ok(await student.call('POST', '/v1/attendance/mark', { qr, location: loc() })));
    expect(res.record.offline).toBe(false);
    const feed = SessionFeed.parse(ok(await teacher.call('GET', `/v1/staff/sessions/${sessionId}/feed`)));
    expect(feed.session.status).toBe('live');
    expect(feed.session.lectureNo).toBe(1);
    expect(feed.entries.find((e) => e.userId === studentId)).toMatchObject({ present: true, source: 'scan' });
    // The teacher's phone syncs its offline "start" later — idempotent, no error.
    const synced = SessionWithSecret.parse(
      ok(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/start`, { mode: 'qr', startedAt: ctx.clock.now - 60_000, clientRef: randomUUID() })),
    );
    expect(synced.session.status).toBe('live');
  });

  it('accepts an offline student scan uploaded later, but only with a consistent code', async () => {
    const kid = new TestDevice(ctx);
    await kid.signIn('b1@iit.ac.in');
    const scannedAt = ctx.clock.now - 10 * 60_000;
    const good = encodeQrToken(secret, sessionId, currentQrSeq(scannedAt, 5));
    const wrong = encodeQrToken(secret, sessionId, currentQrSeq(ctx.clock.now, 5));
    const bad = await kid.call('POST', '/v1/attendance/mark', { qr: wrong, scannedAt, location: loc({ capturedAt: scannedAt }) });
    expect(bad.json().error.rejection.code).toBe('E-EXPIRED');
    // Too old → refused.
    const ancient = ctx.clock.now - 25 * 3_600_000;
    const r = await kid.call('POST', '/v1/attendance/mark', { qr: encodeQrToken(secret, sessionId, currentQrSeq(ancient, 5)), scannedAt: ancient, location: loc({ capturedAt: ancient }) });
    expect(r.json().error.rejection.code).toBe('E-EXPIRED');
    const res = MarkPresent.parse(ok(await kid.call('POST', '/v1/attendance/mark', { qr: good, scannedAt, location: loc({ capturedAt: scannedAt }) })));
    expect(res.record.offline).toBe(true);
  });

  it('manual register: strict, idempotent, accountable', async () => {
    const roster = ok(await teacher.call('GET', `/v1/staff/courses/${courseId}/roster`)) as { userId: string; fullName: string }[];
    const kid = roster.find((r) => r.fullName === 'New Kid')!.userId;
    const ref = randomUUID();
    const body = { clientRef: ref, recordedAt: ctx.clock.now, present: [kid], absent: [], confirmed: true };
    expect(code(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/register`, { ...body, confirmed: false }))).toBe('BAD_REQUEST');
    expect(code(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/register`, { ...body, clientRef: randomUUID(), present: [seed.outsiderId] }))).toBe('BAD_REQUEST');
    expect(code(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/register`, { ...body, clientRef: randomUUID(), present: [kid], absent: [kid] }))).toBe('BAD_REQUEST');
    expect(code(await otherTeacher.call('POST', `/v1/staff/sessions/${sessionId}/register`, body))).toBe('NOT_FOUND');

    const first = ok(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/register`, body));
    expect(first).toMatchObject({ present: 3, absent: 0, changed: 1, duplicate: false });
    const again = ok(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/register`, body));
    expect(again.duplicate).toBe(true);

    // Removing a SCANNED mark needs a written reason.
    const remove = { clientRef: randomUUID(), recordedAt: ctx.clock.now, present: [], absent: [studentId], confirmed: true };
    expect(code(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/register`, remove))).toBe('BAD_REQUEST');
    ok(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/register`, { ...remove, note: 'Left after 5 minutes' }));
    const feed = SessionFeed.parse(ok(await teacher.call('GET', `/v1/staff/sessions/${sessionId}/feed`)));
    expect(feed.entries.find((e) => e.userId === studentId)).toMatchObject({ present: false, revokedReason: 'Marked absent in register: Left after 5 minutes' });

    // The student can't re-add themselves by scanning again.
    const qr = encodeQrToken(secret, sessionId, currentQrSeq(ctx.clock.now, 5));
    const rescan = await student.call('POST', '/v1/attendance/mark', { qr, location: loc() });
    expect(rescan.json().error.rejection.code).toBe('E-REVOKED');
    // Their percentage reflects it.
    const detail = SubjectDetailResponse.parse(ok(await student.call('GET', `/v1/me/subjects/${courseId}`)));
    // While the class is still running it isn't counted as held yet (it is once it ends — see the report test).
    expect(detail.subject).toMatchObject({ attended: 0, held: 0 });
    expect(detail.history.find((h) => h.sessionId === sessionId)).toMatchObject({ status: 'live' });
    expect(detail.history.some((h) => h.status === 'upcoming')).toBe(true);
  });

  it('a manual-mode class never accepts QR scans, and future classes cannot be registered', async () => {
    const extra = StaffSession.parse(
      ok(await teacher.call('POST', '/v1/staff/sessions', { courseId, date: new Date(ctx.clock.now + 5.5 * 3_600_000 + 3 * 86_400_000).toISOString().slice(0, 10), start: '09:00', end: '10:00', roomId, mode: 'manual' })),
    );
    const reg = await teacher.call('POST', `/v1/staff/sessions/${extra.id}/register`, { clientRef: randomUUID(), recordedAt: ctx.clock.now, present: [studentId], absent: [], confirmed: true });
    expect(code(reg)).toBe('BAD_REQUEST');
    const withSecret = SessionWithSecret.parse(ok(await teacher.call('GET', `/v1/staff/sessions/${extra.id}`)));
    expect(withSecret.secret).toBeNull();
    const cancelled = StaffSession.parse(ok(await teacher.call('POST', `/v1/staff/sessions/${extra.id}/cancel`, {})));
    expect(cancelled.status).toBe('cancelled');
    // Even with the class secret (e.g. leaked), a manual-register class refuses QR marks.
    const today = new Date(ctx.clock.now + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const paper = StaffSession.parse(ok(await teacher.call('POST', '/v1/staff/sessions', { courseId, date: today, start: '00:02', end: '23:57', roomId, mode: 'manual' })));
    const leaked = (await ctx.db.query<{ qr_secret: Buffer }>('select qr_secret from class_sessions where id = $1', [paper.id])).rows[0]!.qr_secret;
    const scan = await student.call('POST', '/v1/attendance/mark', { qr: encodeQrToken(new Uint8Array(leaked), paper.id, currentQrSeq(ctx.clock.now, 5)), location: loc() });
    expect(scan.json().error.rejection).toMatchObject({ code: 'E-SESSION-CLOSED', detail: 'This class uses a paper/manual register.' });
  });

  it('ends the class (also when synced from an offline phone) and reports correctly', async () => {
    const ended = StaffSession.parse(ok(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/end`, { endedAt: ctx.clock.now, clientRef: randomUUID() })));
    expect(ended.status).toBe('closed');
    ok(await teacher.call('POST', `/v1/staff/sessions/${sessionId}/end`, { endedAt: ctx.clock.now }));
    const report = CourseReport.parse(ok(await teacher.call('GET', `/v1/staff/courses/${courseId}/report`)));
    expect(report.held).toBe(1);
    const byName = Object.fromEntries(report.students.map((s) => [s.fullName, s]));
    expect(byName['aarav']).toMatchObject({ attended: 0, held: 1, standing: 'at-risk' });
    expect(byName['New Kid']).toMatchObject({ attended: 1, percent: 100 });
    // Online scans after the class ended are refused.
    const late = await student.call('POST', '/v1/attendance/mark', { qr: encodeQrToken(secret, sessionId, currentQrSeq(ctx.clock.now, 5)), location: loc() });
    expect(late.statusCode).toBe(422);
  });
});

describe('review and devices', () => {
  it('a flagged scan can be accepted by the teacher', async () => {
    const s = StaffSession.parse(
      ok(await teacher.call('POST', '/v1/staff/sessions', { courseId, date: new Date(ctx.clock.now + 5.5 * 3_600_000).toISOString().slice(0, 10), start: '00:01', end: '23:58', roomId })),
    );
    const started = SessionWithSecret.parse(ok(await teacher.call('POST', `/v1/staff/sessions/${s.id}/start`, { mode: 'qr', lat: CENTER.lat, lng: CENTER.lng })));
    const qr = encodeQrToken(fromB64url(started.secret!), s.id, currentQrSeq(ctx.clock.now, 5));
    const rej = await student.call('POST', '/v1/attendance/mark', { qr, location: loc({ mocked: true }) });
    expect(rej.json().error.rejection.code).toBe('E-MOCK');
    const flags = ok(await teacher.call('GET', '/v1/staff/flags?status=open'));
    const flag = flags.find((f: { sessionId: string }) => f.sessionId === s.id);
    expect(flag.code).toBe('E-MOCK');
    expect(code(await otherTeacher.call('POST', `/v1/staff/flags/${flag.id}`, { action: 'valid' }))).toBe('NOT_FOUND');
    const reviewed = ok(await teacher.call('POST', `/v1/staff/flags/${flag.id}`, { action: 'valid' }));
    expect(reviewed.status).toBe('valid');
    expect(code(await teacher.call('POST', `/v1/staff/flags/${flag.id}`, { action: 'valid' }))).toBe('CONFLICT');
    const feed = SessionFeed.parse(ok(await teacher.call('GET', `/v1/staff/sessions/${s.id}/feed`)));
    expect(feed.entries.find((e) => e.userId === studentId)).toMatchObject({ present: true, source: 'review' });
  });

  it('admin approves a phone switch: new phone works, old phone is locked out', async () => {
    const { bindProofString, signB64 } = await import('@attendly/protocol');
    const newPhone = new TestDevice(ctx, { model: 'Galaxy S24' });
    ctx.clock.now += 31_000;
    const r = await newPhone.requestOtp('aarav@iit.ac.in');
    const v = await newPhone.verifyOtp(r.json().challengeId, newPhone.lastCode('aarav@iit.ac.in'));
    expect(v.json().status).toBe('device_mismatch');
    const proof = signB64(bindProofString({ ticket: v.json().ticket, publicKeyB64: newPhone.publicKeyB64, purpose: 'rebind' }), newPhone.keys.secretKey);
    ok(await ctx.app.inject({ method: 'POST', url: '/v1/devices/rebind-request', payload: { ticket: v.json().ticket, proof, reason: 'Upgraded phone' } }));

    const list = ok(await admin.call('GET', '/v1/staff/device-requests'));
    const req = list.find((x: { user: { id: string } }) => x.user.id === studentId);
    expect(req).toMatchObject({ kind: 'rebind', to: { model: 'Galaxy S24' } });
    ok(await admin.call('POST', `/v1/staff/device-requests/${req.id}`, { decision: 'approve' }));
    expect(code(await admin.call('POST', `/v1/staff/device-requests/${req.id}`, { decision: 'approve' }))).toBe('CONFLICT');

    expect(code(await student.call('GET', '/v1/me/profile'))).toBe('DEVICE_REVOKED');
    ctx.clock.now += 31_000;
    const signedIn = await newPhone.signIn('aarav@iit.ac.in');
    expect(signedIn.status).toBe('ok');
    expect(ok(await newPhone.call('GET', '/v1/me/profile')).device.model).toBe('Galaxy S24');
    student = newPhone;
  });

  it('admin can suspend and reset people; suspension ends their sessions', async () => {
    const people = Person.array().parse(ok(await admin.call('GET', '/v1/staff/people?role=student&q=bulk')));
    expect(people).toHaveLength(1);
    const p = Person.parse(ok(await admin.call('POST', `/v1/staff/people/${people[0]!.id}`, { status: 'suspended' })));
    expect(p.status).toBe('suspended');
    expect(code(await admin.call('POST', `/v1/staff/people/${(await ctx.db.query<{ id: string }>(`select id from users where email = 'head@iit.ac.in'`)).rows[0]!.id}`, { status: 'suspended' }))).toBe(
      'BAD_REQUEST',
    );
    const staff = Person.array().parse(ok(await admin.call('GET', '/v1/staff/people?role=staff')));
    expect(staff.map((s) => s.role).sort()).toEqual(['admin', 'teacher', 'teacher']);
  });
});

describe('institution', () => {
  it('only the main admin changes the institution settings (with validation)', async () => {
    expect((await admin.call('POST', '/v1/staff/institution', { minAttendance: 80 })).statusCode).toBe(403);
    await ctx.db.query(`update users set is_owner = true where email = 'head@iit.ac.in'`);
    const s = ok(await admin.call('POST', '/v1/staff/institution', { minAttendance: 80, termName: 'Autumn 2026' }));
    expect(s).toMatchObject({ minAttendance: 80, termName: 'Autumn 2026' });
    expect(code(await admin.call('POST', '/v1/staff/institution', { timezone: 'Mars/Olympus' }))).toBe('BAD_REQUEST');
    ok(await admin.call('POST', '/v1/staff/institution', { minAttendance: 75 }));
  });

  it('bootstrap creates the first institution and admin exactly once', async () => {
    const config = { ...ctx.deps.config, bootstrap: { institutionName: 'St. Xavier’s College', adminEmail: 'principal@xaviers.edu', adminName: 'Principal', demoStudentEmail: 'demo@xaviers.edu', demoTeacherEmail: 'teacher.demo@xaviers.edu', developerEmail: 'owner@xaviers.edu', timezone: 'Asia/Kolkata' } };
    const quiet = () => {};
    await bootstrapInstitution(ctx.db, config, quiet);
    await bootstrapInstitution(ctx.db, config, quiet);
    const { rows } = await ctx.db.query<{ slug: string; n: number }>(
      `select t.slug, (select count(*) from users u where u.tenant_id = t.id)::int as n from tenants t where t.name = 'St. Xavier’s College'`,
    );
    expect(rows).toEqual([{ slug: 'st-xavier-s-college', n: 4 }]);
    const p = new TestDevice(ctx);
    await p.signIn('principal@xaviers.edu');
    expect(ok(await p.call('GET', '/v1/staff/overview')).role).toBe('admin');
    // The owner's developer account (a real one: full console, not a sandbox).
    const owner = new TestDevice(ctx);
    await owner.signIn('owner@xaviers.edu');
    expect(ok(await owner.call('GET', '/v1/root/console')).sandbox).toBe(false);
  });

  it('every staff action is in the tamper-evident audit log', async () => {
    const actions = (await ctx.db.query<{ action: string }>(`select distinct action from audit_log`)).rows.map((r) => r.action);
    for (const a of ['room.create', 'course.create', 'person.create', 'timetable.create', 'register.save', 'session.end', 'flag.review', 'device_request.approve', 'offline_pack.issued'])
      expect(actions).toContain(a);
    expect((await verifyAuditChain(ctx.db)).ok).toBe(true);
  });
});
