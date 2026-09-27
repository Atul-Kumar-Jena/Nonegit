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

describe('the class clock', () => {
  it('a class goes live by itself at its start time, and its professor is told to open the QR', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled', startedAt: ctx.clock.now + 60_000 });
    expect((await tickClasses(ctx.db, new Date(ctx.clock.now))).started).toBe(0); // not yet
    const r = await tickClasses(ctx.db, new Date(ctx.clock.now + 61_000));
    expect(r.started).toBeGreaterThanOrEqual(1);
    expect(await status(s.id)).toEqual({ status: 'live', auto_started: true });
    const n = await bell(teacherId, 'live');
    expect(n.at(-1)?.title).toBe('▶ CS-301 is live now');
    expect(n.at(-1)?.body).toMatch(/Open the QR/);
    // …and closes 15 minutes after its end.
    const end = ctx.clock.now + 60_000 + 3_600_000;
    await tickClasses(ctx.db, new Date(end + AUTO_CLOSE_AFTER_MS - 1000));
    expect((await status(s.id)).status).toBe('live');
    await tickClasses(ctx.db, new Date(end + AUTO_CLOSE_AFTER_MS + 1000));
    expect((await status(s.id)).status).toBe('closed');
  });

  it('a QR class with no known location waits for its professor to start it', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.otherCourseId, status: 'scheduled', startedAt: ctx.clock.now - 60_000 });
    await ctx.db.query('update class_sessions set lat = null, lng = null where id = $1', [s.id]);
    await tickClasses(ctx.db, new Date(ctx.clock.now));
    expect((await status(s.id)).status).toBe('scheduled');
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
