import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { currentQrSeq, encodeQrToken } from '@attendly/protocol';
import { at, createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';
import { createGuard, DEVICE_MAX_PER_MIN, IP_FAILURES_TO_BLOCK } from '../src/lib/guard';

let ctx: TestCtx;
let seed: Seeded;
let aarav: TestDevice;

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  aarav = new TestDevice(ctx);
  await aarav.signIn('aarav@iit.ac.in');
});
afterAll(async () => ctx?.close());
beforeEach(async () => {
  ctx.clock.now = Date.now();
  await ctx.db.query('delete from attendance_records');
  await ctx.db.query('delete from scan_rejections');
  await ctx.db.query('delete from tenant_flags');
  await ctx.db.query('delete from device_online');
  await ctx.db.query('delete from notifications');
});

const loc = (capturedAt: number) => ({ ...at(5), accuracyM: 8, mocked: false, capturedAt });
const rej = (res: { json(): any }) => res.json().error?.rejection;

describe('old or forwarded QR codes', () => {
  it('a forwarded screenshot 30 s old is refused', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, startedAt: ctx.clock.now - 10 * 60_000 });
    const old = encodeQrToken(s.secret, s.id, currentQrSeq(ctx.clock.now - 30_000, 7));
    // Scanned now (from the screenshot) and sent at once.
    expect(rej(await aarav.call('POST', '/v1/attendance/mark', { qr: old, scannedAt: ctx.clock.now, location: loc(ctx.clock.now) })).code).toBe('E-EXPIRED');
  });

  it('setting the phone’s clock back doesn’t help: only the delay between scan and send counts', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, startedAt: ctx.clock.now - 10 * 60_000 });
    const then = ctx.clock.now - 30_000;
    const old = encodeQrToken(s.secret, s.id, currentQrSeq(then, 7));
    // Phone clock 30 s behind: it stamps both the scan and the request with its wrong time.
    const r = await aarav.call('POST', '/v1/attendance/mark', { qr: old, scannedAt: then, location: loc(then) }, { ts: then });
    expect(rej(r).code).toBe('E-EXPIRED');
  });

  it('the since-boot clock can’t be faked by changing the time between scanning and sending', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, startedAt: ctx.clock.now - 10 * 60_000 });
    const then = ctx.clock.now - 30_000;
    const old = encodeQrToken(s.secret, s.id, currentQrSeq(then, 7));
    // Wall clock says "scanned 30 s ago", but the since-boot clock shows it was scanned just now.
    const r = await aarav.call('POST', '/v1/attendance/mark', { qr: old, scannedAt: then, clock: { boot: 7, scanMs: 500_000, sendMs: 501_000 }, location: loc(then) });
    expect(rej(r).code).toBe('E-EXPIRED');
    // A wall clock hours away from the since-boot story is tampering.
    const far = await aarav.call('POST', '/v1/attendance/mark', {
      qr: old,
      scannedAt: ctx.clock.now - 3 * 3_600_000,
      clock: { boot: 7, scanMs: 500_000, sendMs: 501_000 },
      location: loc(ctx.clock.now - 3 * 3_600_000),
    });
    expect(rej(far).code).toBe('E-QR-INVALID');
    // And an honest live scan with the boot clock is fine.
    const live = encodeQrToken(s.secret, s.id, currentQrSeq(ctx.clock.now - 2_000, 7));
    const ok = await aarav.call('POST', '/v1/attendance/mark', {
      qr: live,
      scannedAt: ctx.clock.now - 2_000,
      clock: { boot: 7, scanMs: 600_000, sendMs: 602_000 },
      location: loc(ctx.clock.now - 2_000),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().record.offline).toBe(false);
  });

  it('a live code scanned seconds ago is accepted', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const scannedAt = ctx.clock.now - 6_000;
    const res = await aarav.call('POST', '/v1/attendance/mark', { qr: encodeQrToken(s.secret, s.id, currentQrSeq(scannedAt, 7)), scannedAt, location: loc(scannedAt) });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.offline).toBe(false);
  });

  it('an "offline" scan is refused when the phone was online well after it without sending it', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, startedAt: ctx.clock.now - 60 * 60_000 });
    const scannedAt = ctx.clock.now - 40 * 60_000;
    const qr = encodeQrToken(s.secret, s.id, currentQrSeq(scannedAt, 7));
    // The phone used the app online 20 minutes ago.
    const real = ctx.clock.now;
    ctx.clock.now = real - 20 * 60_000;
    expect((await aarav.call('GET', '/v1/me/dashboard')).statusCode).toBe(200);
    ctx.clock.now = real;
    const r = rej(await aarav.call('POST', '/v1/attendance/mark', { qr, scannedAt, location: loc(scannedAt) }));
    expect(r.code).toBe('E-QR-INVALID');
    expect(r.detail).toMatch(/online after that scan/);
  });

  it('a genuine offline scan (uploaded as soon as the phone is back online) is accepted', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, startedAt: ctx.clock.now - 60 * 60_000 });
    const scannedAt = ctx.clock.now - 40 * 60_000;
    // Back online: the app refreshes its screens, then uploads.
    expect((await aarav.call('GET', '/v1/me/dashboard')).statusCode).toBe(200);
    const res = await aarav.call('POST', '/v1/attendance/mark', { qr: encodeQrToken(s.secret, s.id, currentQrSeq(scannedAt, 7)), scannedAt, location: loc(scannedAt) });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.offline).toBe(true);
    // The student is told it counted, in a structured notification.
    const n = (await ctx.db.query(`select title, body, data from notifications where user_id = $1 and kind = 'attendance'`, [seed.studentId])).rows;
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('✅ Attendance marked · CS-301');
    expect(n[0].body).toMatch(/without internet — now confirmed\. Your attendance: 100%\./);
    expect(n[0].data.sessionId).toBe(s.id);
    // Live scans don't add a notification (the student is looking at the result screen).
  });

  it('institutions can refuse offline scans altogether', async () => {
    await ctx.db.query(`insert into tenant_flags(tenant_id, key, enabled) values ($1, 'offline_scans_off', true)`, [seed.tenantId]);
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, startedAt: ctx.clock.now - 60 * 60_000 });
    const scannedAt = ctx.clock.now - 10 * 60_000;
    const r = rej(await aarav.call('POST', '/v1/attendance/mark', { qr: encodeQrToken(s.secret, s.id, currentQrSeq(scannedAt, 7)), scannedAt, location: loc(scannedAt) }));
    expect(r.detail).toMatch(/only live scans/);
  });
});

describe('abuse guard', () => {
  it('limits each phone per minute and shuts out IPs that keep probing', () => {
    const g = createGuard();
    for (let i = 0; i < DEVICE_MAX_PER_MIN; i++) expect(g.deviceAllowed('d', 1000)).toBe(true);
    expect(g.deviceAllowed('d', 1000)).toBe(false);
    expect(g.deviceAllowed('d', 62_000)).toBe(true);
    for (let i = 0; i < IP_FAILURES_TO_BLOCK - 1; i++) g.recordProbe('1.2.3.4', 5000);
    expect(g.ipBlockedFor('1.2.3.4', 5000)).toBe(0);
    g.recordProbe('1.2.3.4', 5000);
    expect(g.ipBlockedFor('1.2.3.4', 6000)).toBeGreaterThan(0);
    expect(g.ipBlockedFor('5.6.7.8', 6000)).toBe(0);
  });

  it('bad signatures from one IP end in a block (server-level)', async () => {
    const guarded = await createTestApp({}, { rateLimit: true });
    try {
      const dev = new TestDevice(guarded);
      for (let i = 0; i < IP_FAILURES_TO_BLOCK; i++)
        await guarded.app.inject({ method: 'GET', url: '/v1/me/dashboard', headers: { authorization: `Bearer ${'A'.repeat(43)}` } });
      const blocked = await guarded.app.inject({ method: 'GET', url: '/v1/meta' });
      expect(blocked.statusCode).toBe(429);
      expect(dev).toBeTruthy();
    } finally {
      await guarded.close();
    }
  });

  it('sends protective security headers', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/meta' });
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
