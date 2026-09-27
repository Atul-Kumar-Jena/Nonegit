import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MarkResponse,
  DashboardResponse,
  SubjectsResponse,
  ProfileResponse,
  currentQrSeq,
  encodeQrToken,
  fromB64url,
  randomBytes,
  receiptSigningString,
  verifyB64,
} from '@attendly/protocol';
import { at, createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx, liveToken } from './harness';
import { verifyAuditChain } from '../src/lib/audit';

let ctx: TestCtx;
let seed: Seeded;
let aarav: TestDevice;
let meta: { serverKey: { kid: string; publicKey: string } };

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  aarav = new TestDevice(ctx);
  await aarav.signIn('aarav@iit.ac.in');
  meta = (await ctx.app.inject({ method: 'GET', url: '/v1/meta' })).json();
});
afterAll(async () => ctx?.close());
beforeEach(() => {
  ctx.clock.now = Date.now();
});

function loc(metersNorth = 5, extra: Partial<{ accuracyM: number; mocked: boolean; capturedAt: number }> = {}) {
  return { ...at(metersNorth), accuracyM: 8, mocked: false, capturedAt: ctx.clock.now, ...extra };
}

async function mark(device: TestDevice, qr: string, location = loc()) {
  return device.call('POST', '/v1/attendance/mark', { qr, location });
}

function rejection(res: { statusCode: number; json(): any }) {
  expect(res.statusCode).toBe(422);
  const body = res.json();
  expect(body.error.code).toBe('REJECTED');
  return body.error.rejection as { code: string; title: string; hint: string; detail?: string };
}

describe('marking attendance', () => {
  it('accepts a fresh token inside the geofence and returns a verifiable receipt', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    ctx.clock.now += 3_000;
    const res = await mark(aarav, liveToken(ctx, s));
    expect(res.statusCode).toBe(200);
    const body = MarkResponse.parse(res.json());
    expect(body.alreadyMarked).toBe(false);
    expect(body.record.distanceM).toBe(5);
    expect(body.course).toEqual({ before: null, after: 100 });

    // The client can verify the receipt offline with the pinned server key.
    const signed = receiptSigningString({
      recordId: body.record.id,
      sessionId: body.record.sessionId,
      userId: body.receipt.userId,
      markedAt: body.record.markedAt,
      deviceFingerprint: body.receipt.deviceFingerprint,
      qrSeq: body.record.qrSeq,
      serverKeyId: body.receipt.serverKeyId,
    });
    expect(body.receipt.serverKeyId).toBe(meta.serverKey.kid);
    expect(verifyB64(body.receipt.signature, signed, fromB64url(meta.serverKey.publicKey))).toBe(true);
    expect(verifyB64(body.receipt.signature, signed.replace(body.record.id, '00000000-0000-4000-8000-000000000000'), fromB64url(meta.serverKey.publicKey))).toBe(false);

    // Evidence is stored: device signature over the exact request.
    const { rows } = await ctx.db.query('select device_signature, request_digest, source from attendance_records where id = $1', [body.record.id]);
    expect(rows[0].device_signature).toHaveLength(64);
    expect(rows[0].request_digest).toHaveLength(32);
    expect(rows[0].source).toBe('scan');

    // A retry (e.g. the response was lost) is idempotent — same record, even after the token rotated.
    ctx.clock.now += 60_000;
    const retry = await mark(aarav, liveToken(ctx, s), loc(5));
    expect(retry.statusCode).toBe(200);
    expect(retry.json().alreadyMarked).toBe(true);
    expect(retry.json().record.id).toBe(body.record.id);
  });

  it('accepts the previous and next rotation but not older/newer', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, rotationS: 5, startedAt: ctx.clock.now - 50_000 });
    for (const offset of [-2, 2]) expect(rejection(await mark(aarav, liveToken(ctx, s, 5, offset))).code).toBe('E-EXPIRED');
    expect((await mark(aarav, liveToken(ctx, s, 5, -1))).statusCode).toBe(200);
  });

  it('rejects forged, malformed and cross-institution tokens', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    expect(rejection(await mark(aarav, 'hello world')).code).toBe('E-QR-INVALID');
    expect(rejection(await mark(aarav, encodeQrToken(randomBytes(32), s.id, currentQrSeq(ctx.clock.now, 7)))).code).toBe('E-QR-INVALID');
    const foreign = await startLiveSession(ctx, { tenantId: seed.otherTenantId, courseId: seed.foreignCourseId });
    expect(rejection(await mark(aarav, liveToken(ctx, foreign))).code).toBe('E-QR-INVALID');
    const flipped = liveToken(ctx, s).slice(0, -2) + 'AA';
    expect(rejection(await mark(aarav, flipped)).code).toBe('E-QR-INVALID');
  });

  it('rejects when the session is not live or the student is not enrolled', async () => {
    // A class that starts in two hours can't be scanned yet…
    const later = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled', startedAt: ctx.clock.now + 2 * 3_600_000 });
    expect(rejection(await mark(aarav, liveToken(ctx, later))).code).toBe('E-SESSION-CLOSED');
    // …nor one that is over.
    const done = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'closed', startedAt: ctx.clock.now - 3 * 3_600_000 });
    await ctx.db.query(`update class_sessions set ended_at = scheduled_end where id = $1`, [done.id]);
    expect(rejection(await mark(aarav, liveToken(ctx, done))).code).toBe('E-SESSION-CLOSED');
    const other = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.otherCourseId });
    const r = rejection(await mark(aarav, liveToken(ctx, other)));
    expect(r.code).toBe('E-NOT-ENROLLED');
  });

  it('enforces the geofence and GPS sanity checks', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, radiusM: 50 });
    const q = () => liveToken(ctx, s);
    const geo = rejection(await mark(aarav, q(), loc(184)));
    expect(geo.code).toBe('E-GEO');
    expect(geo.detail).toBe("You're 184m from LH-2. Sessions accept marks only inside the 50m perimeter.");
    expect(rejection(await mark(aarav, q(), loc(10, { mocked: true }))).code).toBe('E-MOCK');
    expect(rejection(await mark(aarav, q(), loc(10, { accuracyM: 0 }))).code).toBe('E-MOCK');
    expect(rejection(await mark(aarav, q(), loc(10, { accuracyM: 150 }))).code).toBe('E-GPS-WEAK');
    expect(rejection(await mark(aarav, q(), loc(10, { capturedAt: ctx.clock.now - 120_000 }))).code).toBe('E-GPS-STALE');
    // A large claimed accuracy does not widen the fence beyond +10m.
    expect(rejection(await mark(aarav, q(), loc(65, { accuracyM: 70 }))).code).toBe('E-GEO');

    const { rows } = await ctx.db.query(`select code, suspicious from scan_rejections where session_id = $1 order by id`, [s.id]);
    expect(rows.map((r: { code: string }) => r.code)).toEqual(['E-GEO', 'E-MOCK', 'E-MOCK', 'E-GPS-WEAK', 'E-GPS-STALE', 'E-GEO']);
    expect(rows.filter((r: { suspicious: boolean }) => r.suspicious)).toHaveLength(2);

    // Finally, a genuine mark inside the fence (with jitter allowance) succeeds.
    expect((await mark(aarav, q(), loc(58, { accuracyM: 12 }))).statusCode).toBe(200);
  });

  it('honours the global kill switch', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    await ctx.db.query(`update system_flags set enabled = true where key = 'scans_paused'`);
    try {
      expect(rejection(await mark(aarav, liveToken(ctx, s))).code).toBe('E-PAUSED');
    } finally {
      await ctx.db.query(`update system_flags set enabled = false where key = 'scans_paused'`);
    }
  });

  it('concurrent submissions from the same student create exactly one record', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const results = await Promise.all(Array.from({ length: 8 }, () => mark(aarav, liveToken(ctx, s))));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const ids = new Set(results.map((r) => r.json().record.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.json().alreadyMarked === false)).toHaveLength(1);
    const { rows } = await ctx.db.query('select count(*)::int as n from attendance_records where session_id = $1', [s.id]);
    expect(rows[0].n).toBe(1);
  });

  it('throttles a device that keeps failing scans', async () => {
    const p = new TestDevice(ctx);
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'Spam', 'spam@iit.ac.in')`, [seed.tenantId]);
    await p.signIn('spam@iit.ac.in');
    for (let i = 0; i < 10; i++) rejection(await mark(p, 'garbage'));
    const r = await mark(p, 'garbage');
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('student data', () => {
  it('dashboard, subjects and profile reflect marks with the 75% rule', async () => {
    const p = new TestDevice(ctx);
    const u = await ctx.db.query<{ id: string }>(
      `insert into users(tenant_id, role, full_name, email, roll_no) values ($1, 'student', 'Stat Student', 'stat@iit.ac.in', 'S1') returning id`,
      [seed.tenantId],
    );
    await ctx.db.query('insert into enrollments(course_id, user_id) values ($1, $2)', [seed.courseId, u.rows[0]!.id]);
    await p.signIn('stat@iit.ac.in');

    // 4 closed sessions, attends 2 → 50% (at risk), then a live one marked → 3/5 = 60%.
    for (let i = 0; i < 4; i++) {
      const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
      if (i < 2) expect((await mark(p, liveToken(ctx, s))).statusCode).toBe(200);
      await ctx.db.query(`update class_sessions set status = 'closed' where id = $1`, [s.id]);
    }
    // Close every other open session in this course so the numbers are exact.
    await ctx.db.query(`update class_sessions set status = 'closed' where course_id = $1 and status = 'live'`, [seed.courseId]);
    const { rows: heldRows } = await ctx.db.query(`select count(*)::int as n from class_sessions where course_id = $1 and status = 'closed'`, [seed.courseId]);
    const held = heldRows[0].n as number;

    const live = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const dashBefore = DashboardResponse.parse((await p.call('GET', '/v1/me/dashboard')).json());
    expect(dashBefore.term.held).toBe(held); // a live, unmarked session does not count yet
    expect(dashBefore.term.attended).toBe(2);
    const liveItem = dashBefore.today.find((t) => t.sessionId === live.id);
    expect(liveItem).toMatchObject({ status: 'live', marked: false, courseCode: 'CS-301' });

    const m = MarkResponse.parse((await mark(p, liveToken(ctx, live))).json());
    expect(m.course.before).toBeCloseTo((2 / held) * 100, 0);
    expect(m.course.after).toBeCloseTo((3 / (held + 1)) * 100, 0);

    const dash = DashboardResponse.parse((await p.call('GET', '/v1/me/dashboard')).json());
    expect(dash.term).toMatchObject({ attended: 3, held: held + 1, minPercent: 75 });
    expect(dash.today.find((t) => t.sessionId === live.id)?.marked).toBe(true);

    const subj = SubjectsResponse.parse((await p.call('GET', '/v1/me/subjects')).json());
    expect(subj.subjects).toHaveLength(1);
    const cs = subj.subjects[0]!;
    expect(cs).toMatchObject({ code: 'CS-301', attended: 3, held: held + 1, standing: 'at-risk', safeToMiss: 0 });
    expect((3 + cs.needToReach) / (held + 1 + cs.needToReach)).toBeGreaterThanOrEqual(0.75);

    const prof = ProfileResponse.parse((await p.call('GET', '/v1/me/profile')).json());
    expect(prof.user.fullName).toBe('Stat Student');
    expect(prof.device.status).toBe('active');
    expect(prof.lastScanAt).not.toBeNull();
  });
});

describe('audit log', () => {
  it('is hash-chained, append-only and detects tampering', async () => {
    const before = await verifyAuditChain(ctx.db);
    expect(before.ok).toBe(true);
    expect(before.checked).toBeGreaterThan(10);

    await expect(ctx.db.query(`update audit_log set action = 'x' where id = 1`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`delete from audit_log where id = 1`)).rejects.toThrow(/append-only/);

    // Simulate an attacker with superuser DB access who bypasses the trigger.
    await ctx.db.query('alter table audit_log disable trigger audit_log_no_update');
    await ctx.db.query(`update audit_log set data = '{"code":"forged"}' where id = (select min(id) + 3 from audit_log)`);
    await ctx.db.query('alter table audit_log enable trigger audit_log_no_update');
    const after = await verifyAuditChain(ctx.db);
    expect(after.ok).toBe(false);
    expect(after.brokenAtId).toBeGreaterThan(0);
  });
});
