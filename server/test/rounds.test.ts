import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qrRoundSecret } from '@attendly/protocol';
import { at, createTestApp, liveToken, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let aarav: TestDevice;
let priya: TestDevice;
let prof: TestDevice;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const loc = () => ({ ...at(5), accuracyM: 8, mocked: false, capturedAt: ctx.clock.now });
const scan = (d: TestDevice, s: { id: string; secret: Uint8Array }) => d.call('POST', '/v1/attendance/mark', { qr: liveToken(ctx, s, 5), location: loc() });

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'Prof', 'prof@iit.ac.in')`, [seed.tenantId]);
  await ctx.db.query(`update courses set instructor_id = (select id from users where email = 'prof@iit.ac.in') where id = $1`, [seed.courseId]);
  aarav = new TestDevice(ctx);
  priya = new TestDevice(ctx);
  prof = new TestDevice(ctx);
  await aarav.signIn('aarav@iit.ac.in');
  await priya.signIn('priya@iit.ac.in');
  await prof.signIn('prof@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('the class closes itself when everyone is marked', () => {
  it('last student scans → closed (auto), the code stops working, the professor sees why', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, rotationS: 5 });
    expect(ok(await scan(aarav, s)).status).toBe('present');
    let st = ok(await prof.call('GET', `/v1/staff/sessions/${s.id}`)).session;
    expect(st.status).toBe('live');
    expect(ok(await scan(priya, s)).status).toBe('present');
    st = ok(await prof.call('GET', `/v1/staff/sessions/${s.id}`)).session;
    expect(st).toMatchObject({ status: 'closed', autoEnded: true, marked: 2 });
    expect((await ctx.db.query(`select 1 from audit_log where action = 'session.auto_end' and subject = $1`, [`session:${s.id}`])).rowCount).toBe(1);
  });
});

describe('layered scans (fests, webinars)', () => {
  // Each round has its own key: the professor's screen shows round k's code only once round k is open.
  const scanRound = (d: TestDevice, s: { id: string; secret: Uint8Array }, round: number) =>
    d.call('POST', '/v1/attendance/mark', { qr: liveToken(ctx, { id: s.id, secret: qrRoundSecret(s.secret, round) }, 5), location: loc() });
  const rejection = (r: { body: string }) => JSON.parse(r.body).error?.rejection?.code;
  /** The class clock jumps ahead in these tests: keep everyone signed in like the apps do. */
  const fresh = async () => {
    for (const d of [aarav, priya, prof]) {
      const r = await d.refresh();
      if (r.statusCode === 200) d.adopt(r.json().auth ?? r.json());
    }
  };

  it('present only after every round, scanned in order from one phone; each round has its own code', async () => {
    ctx.clock.now += 60_000;
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, rotationS: 5 });
    expect(ok(await prof.call('POST', `/v1/staff/sessions/${s.id}/rounds`, { rounds: 3 })).scanRounds).toBe(3);
    // Round 1
    const r1 = ok(await scanRound(aarav, s, 1));
    expect(r1).toMatchObject({ status: 'round', round: { done: 1, required: 3, current: 1 } });
    // Scanning again in the same round changes nothing.
    expect(ok(await scanRound(aarav, s, 1)).round.done).toBe(1);
    // Round 2's code doesn't exist yet: nobody can get ahead.
    expect(rejection(await scanRound(aarav, s, 2))).toBe('E-QR-INVALID');
    // The number of scans is fixed once scanning has started.
    expect((await prof.call('POST', `/v1/staff/sessions/${s.id}/rounds`, { rounds: 2 })).statusCode).toBe(409);
    // Round 2 opens: students are told, and only the new code counts for it.
    ctx.clock.now += 6 * 60_000;
    const st = ok(await prof.call('POST', `/v1/staff/sessions/${s.id}/next-round`, {}));
    expect(st).toMatchObject({ roundNo: 2, roundCounts: [1, 0, 0], roundDone: false });
    expect((await ctx.db.query(`select 1 from notifications where title like '%Scan again%' and user_id = $1`, [seed.studentId])).rowCount).toBe(1);
    expect(ok(await scanRound(aarav, s, 2)).round.done).toBe(2);
    // Priya skipped round 1: round 2 can't count for her — the chain has a gap.
    expect(rejection(await scanRound(priya, s, 2))).toBe('E-ROUND');
    // Round 3: Aarav completes → present with a receipt, and his chain head is kept with the record.
    ctx.clock.now += 6 * 60_000;
    ok(await prof.call('POST', `/v1/staff/sessions/${s.id}/next-round`, {}));
    const done = ok(await scanRound(aarav, s, 3));
    expect(done.status).toBe('present');
    expect(done.receipt.signature).toBeTruthy();
    const rec = await ctx.db.query<{ round_chain: Buffer | null }>('select round_chain from attendance_records where session_id = $1 and user_id = $2', [s.id, seed.studentId]);
    expect(rec.rows[0]!.round_chain?.length).toBe(32);
    const fin = ok(await prof.call('GET', `/v1/staff/sessions/${s.id}`)).session;
    expect(fin).toMatchObject({ marked: 1, status: 'live' }); // Priya isn't present: stays open
    expect((await prof.call('POST', `/v1/staff/sessions/${s.id}/next-round`, {})).statusCode).toBe(409);
  });

  it('a round is “done” when everyone has it; after the last round everyone present closes the class', async () => {
    ctx.clock.now += 60_000;
    await fresh();
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, rotationS: 5 });
    ok(await prof.call('POST', `/v1/staff/sessions/${s.id}/rounds`, { rounds: 2 }));
    ok(await scanRound(aarav, s, 1));
    expect(ok(await prof.call('GET', `/v1/staff/sessions/${s.id}`)).session.roundDone).toBe(false);
    ok(await scanRound(priya, s, 1));
    expect(ok(await prof.call('GET', `/v1/staff/sessions/${s.id}`)).session.roundDone).toBe(true);
    ctx.clock.now += 6 * 60_000;
    ok(await prof.call('POST', `/v1/staff/sessions/${s.id}/next-round`, {}));
    expect(ok(await scanRound(aarav, s, 2)).status).toBe('present');
    expect(ok(await scanRound(priya, s, 2)).status).toBe('present');
    expect(ok(await prof.call('GET', `/v1/staff/sessions/${s.id}`)).session).toMatchObject({ status: 'closed', autoEnded: true, marked: 2 });
  });

  it('a tampered link breaks the chain: the student is not marked', async () => {
    ctx.clock.now += 60_000;
    await fresh();
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, rotationS: 5 });
    ok(await prof.call('POST', `/v1/staff/sessions/${s.id}/rounds`, { rounds: 2 }));
    ok(await scanRound(aarav, s, 1));
    // Someone edits the stored round-1 scan (e.g. straight in the database).
    await ctx.db.query('update scan_round_marks set qr_seq = qr_seq - 1 where session_id = $1 and user_id = $2', [s.id, seed.studentId]);
    ctx.clock.now += 6 * 60_000;
    ok(await prof.call('POST', `/v1/staff/sessions/${s.id}/next-round`, {}));
    expect(rejection(await scanRound(aarav, s, 2))).toBe('E-ROUND');
    expect((await ctx.db.query('select 1 from attendance_records where session_id = $1', [s.id])).rowCount).toBe(0);
  });
});

describe('phones', () => {
  it('an Android phone must say who it is (Android ID) to be registered', async () => {
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'Noid', 'noid@iit.ac.in')`, [seed.tenantId]);
    const d = new TestDevice(ctx, { hardwareId: undefined });
    ctx.clock.now += 31_000;
    const r = await d.requestOtp('noid@iit.ac.in');
    const v = await d.verifyOtp(r.json().challengeId, d.lastCode('noid@iit.ac.in'));
    const b = await d.bind(v.json().ticket);
    expect(b.statusCode).toBe(400);
    expect(b.json().error.message).toContain('update Attendly');
  });

  it('a signed-in student can’t just sign in on another phone: it needs approval', async () => {
    const other = new TestDevice(ctx);
    ctx.clock.now += 31_000;
    const r = await other.requestOtp('aarav@iit.ac.in');
    const v = await other.verifyOtp(r.json().challengeId, other.lastCode('aarav@iit.ac.in'));
    expect(v.json().status).toBe('device_mismatch');
  });
});

describe('professors’ punctuality', () => {
  it('each class: on time, late by N min, or not held — per professor, and a professor sees only their own', async () => {
    const t0 = ctx.clock.now;
    const late = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled', startedAt: t0 - 2 * 3_600_000 });
    await ctx.db.query(`update class_sessions set status = 'closed', started_at = scheduled_start + interval '12 minutes', ended_at = scheduled_start + interval '50 minutes' where id = $1`, [late.id]);
    const gone = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled', startedAt: t0 - 26 * 3_600_000 });
    await ctx.db.query(`update class_sessions set missed_at = scheduled_end where id = $1`, [gone.id]);
    const r = ok(await prof.call('GET', '/v1/staff/reports/punctuality?days=7'));
    const byId = new Map(r.classes.map((c: { sessionId: string }) => [c.sessionId, c]));
    expect(byId.get(late.id)).toMatchObject({ status: 'late', lateMin: 12, teacher: 'Prof' });
    expect(byId.get(gone.id)).toMatchObject({ status: 'missed' });
    const me = r.teachers.find((t: { name: string }) => t.name === 'Prof');
    expect(me.late).toBeGreaterThanOrEqual(1);
    expect(me.missed).toBeGreaterThanOrEqual(1);
    expect(me.avgLateMin).toBeGreaterThan(0);
    expect(r.teachers.every((t: { name: string }) => t.name === 'Prof')).toBe(true);
  });
});

describe('offline register', () => {
  it('taken without internet, uploaded later: saved once, and the professor is told it synced', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled', startedAt: ctx.clock.now - 20 * 60_000 });
    const body = { clientRef: `offline-${Date.now()}`, recordedAt: ctx.clock.now - 10 * 60_000, present: [seed.studentId], absent: [seed.student2Id], confirmed: true };
    const r = ok(await prof.call('POST', `/v1/staff/sessions/${s.id}/register`, body));
    expect(r).toMatchObject({ present: 1, absent: 1, duplicate: false });
    expect(ok(await prof.call('POST', `/v1/staff/sessions/${s.id}/register`, body)).duplicate).toBe(true); // retried upload: no double count
    const n = await ctx.db.query(`select 1 from notifications where title like '%Register synced%'`);
    expect(n.rowCount).toBe(1);
  });
});
