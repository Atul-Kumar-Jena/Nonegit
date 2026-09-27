import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardResponse } from '@attendly/protocol';
import { AUTO_CLOSE_AFTER_MS, tickClasses } from '../src/lib/class-clock';
import { createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let aarav: TestDevice;
let teacher: TestDevice;
let teacherId: string;

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  teacherId = (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'Dr. Kumar', 'kumar@iit.ac.in') returning id`, [seed.tenantId])).rows[0]!.id;
  await ctx.db.query('update courses set instructor_id = $1 where id = $2', [teacherId, seed.courseId]);
  aarav = new TestDevice(ctx);
  await aarav.signIn('aarav@iit.ac.in');
  teacher = new TestDevice(ctx, { hardwareId: 'teacher-phone' });
  await teacher.signIn('kumar@iit.ac.in');
});
afterAll(async () => ctx?.close());

const status = async (id: string) => (await ctx.db.query<{ status: string; auto_started: boolean }>('select status, auto_started from class_sessions where id = $1', [id])).rows[0]!;
const bell = async (userId: string, kind: string) => (await ctx.db.query<{ title: string; body: string }>('select title, body from notifications where user_id = $1 and kind = $2', [userId, kind])).rows;

describe('the class clock: class time vs the professor arriving', () => {
  it('logs the class time starting and reminds the professor — the class isn’t live until they start it', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled', startedAt: ctx.clock.now + 60_000 });
    expect((await tickClasses(ctx.db, new Date(ctx.clock.now))).due).toBe(0); // not yet
    ctx.clock.now += 61_000;
    expect((await tickClasses(ctx.db, new Date(ctx.clock.now))).due).toBeGreaterThanOrEqual(1);
    expect((await status(s.id)).status).toBe('scheduled');
    const n = await bell(teacherId, 'live');
    expect(n.at(-1)?.title).toBe('⏰ CS-301 starts now');
    expect(n.at(-1)?.body).toMatch(/tap Start/);
    // Log 1 on the professor's view; the batch sees "waiting for the professor".
    const staff = (await teacher.call('GET', `/v1/staff/sessions/${s.id}`)).json().session;
    expect(staff.dueAt).not.toBeNull();
    expect(staff.startedAt).toBeNull();
    const waiting = DashboardResponse.parse((await aarav.call('GET', '/v1/me/dashboard')).json()).today.find((t) => t.sessionId === s.id)!;
    expect(waiting).toMatchObject({ status: 'scheduled', waitingForProfessor: true, lateMin: null });
    // A second tick doesn't remind again.
    await tickClasses(ctx.db, new Date(ctx.clock.now + 20_000));
    expect((await bell(teacherId, 'live')).filter((x) => x.title === '⏰ CS-301 starts now')).toHaveLength(n.filter((x) => x.title === '⏰ CS-301 starts now').length);

    // Log 2: the professor arrives 7 minutes late and starts it; the batch sees it live.
    ctx.clock.now += 7 * 60_000;
    const started = await teacher.call('POST', `/v1/staff/sessions/${s.id}/start`, { mode: 'manual' });
    expect(started.statusCode).toBe(200);
    const after = (await teacher.call('GET', `/v1/staff/sessions/${s.id}`)).json().session;
    expect(after).toMatchObject({ status: 'live', lateMin: 7 });
    const live = DashboardResponse.parse((await aarav.call('GET', '/v1/me/dashboard')).json()).today.find((t) => t.sessionId === s.id)!;
    expect(live).toMatchObject({ status: 'live', waitingForProfessor: false, lateMin: 7, taking: false });
    expect((await bell(seed.studentId, 'started')).at(-1)?.title).toBe('▶ CS-301 has started');
    const audit = await ctx.db.query<{ action: string; data: { lateMin?: number } }>(`select action, data from audit_log where subject = $1 order by id`, [`session:${s.id}`]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['session.due', 'session.start']));
    expect(audit.rows.find((r) => r.action === 'session.start')?.data.lateMin).toBe(7);
  });

  it('a class nobody started is logged as missed when its time runs out', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.otherCourseId, status: 'scheduled', startedAt: ctx.clock.now - 30 * 60_000 });
    await tickClasses(ctx.db, new Date(ctx.clock.now));
    expect((await status(s.id)).status).toBe('scheduled');
    const end = (await ctx.db.query<{ scheduled_end: Date }>('select scheduled_end from class_sessions where id = $1', [s.id])).rows[0]!.scheduled_end.getTime();
    expect((await tickClasses(ctx.db, new Date(end + 1000))).missed).toBeGreaterThanOrEqual(1);
    const row = (await ctx.db.query<{ missed_at: Date | null; status: string }>('select missed_at, status from class_sessions where id = $1', [s.id])).rows[0]!;
    expect(row.status).toBe('scheduled');
    expect(row.missed_at).not.toBeNull();
    expect((await ctx.db.query(`select 1 from audit_log where action = 'session.missed' and subject = $1`, [`session:${s.id}`])).rowCount).toBe(1);
  });

  it('classes started by the older clock still close 15 minutes after their end', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    await ctx.db.query('update class_sessions set auto_started = true where id = $1', [s.id]);
    const end = (await ctx.db.query<{ scheduled_end: Date }>('select scheduled_end from class_sessions where id = $1', [s.id])).rows[0]!.scheduled_end.getTime();
    await tickClasses(ctx.db, new Date(end + AUTO_CLOSE_AFTER_MS - 1000));
    expect((await status(s.id)).status).toBe('live');
    await tickClasses(ctx.db, new Date(end + AUTO_CLOSE_AFTER_MS + 1000));
    expect((await status(s.id)).status).toBe('closed');
  });
});

describe('“attendance being taken”', () => {
  it('when the professor shows the QR, students see it on their home screen and get one notification', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const before = DashboardResponse.parse((await aarav.call('GET', '/v1/me/dashboard')).json());
    expect(before.today.find((t) => t.sessionId === s.id)?.taking).toBe(false);
    expect((await teacher.call('POST', `/v1/staff/sessions/${s.id}/showing`, {})).statusCode).toBe(200);
    const after = DashboardResponse.parse((await aarav.call('GET', '/v1/me/dashboard')).json());
    expect(after.today.find((t) => t.sessionId === s.id)?.taking).toBe(true);
    ctx.clock.now += 30_000;
    await teacher.call('POST', `/v1/staff/sessions/${s.id}/showing`, {});
    const n = await bell(seed.studentId, 'taking');
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toBe('📸 Attendance being taken · CS-301');
    // The professor's view says so too.
    expect((await teacher.call('GET', `/v1/staff/sessions/${s.id}`)).json().session.showingQr).toBe(true);
    // Another professor's class: not theirs to show.
    const other = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.otherCourseId });
    expect((await teacher.call('POST', `/v1/staff/sessions/${other.id}/showing`, {})).statusCode).toBe(404);
  });
});
