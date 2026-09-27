import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { at, CENTER, createTestApp, liveToken, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';

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
});

const sample = (north: number, accuracyM: number, ago = 0, extra: { east?: number; mocked?: boolean } = {}) => ({
  lat: CENTER.lat + north / 111_195,
  lng: CENTER.lng + (extra.east ?? 0) / 97_700,
  accuracyM,
  t: ctx.clock.now - ago,
  ...(extra.mocked ? { mocked: true } : {}),
});
async function markWith(samples: ReturnType<typeof sample>[], opts: { summary?: { north: number; accuracyM: number }; courseId?: string } = {}) {
  const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: opts.courseId ?? seed.courseId });
  const sum = opts.summary ?? { north: 5, accuracyM: 8 };
  const location = { ...at(sum.north), accuracyM: sum.accuracyM, mocked: false, capturedAt: ctx.clock.now, samples };
  return { res: await aarav.call('POST', '/v1/attendance/mark', { qr: liveToken(ctx, s), location }), session: s };
}
const code = (res: { json(): any }) => res.json().error?.rejection?.code;

describe('several GPS fixes per scan', () => {
  it('the server fuses the raw fixes itself (a tampered summary position is ignored)', async () => {
    const { res } = await markWith([sample(20, 9, 3000), sample(22, 8, 2000), sample(21, 7, 1000)], { summary: { north: 0, accuracyM: 3 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.distanceM).toBeGreaterThanOrEqual(20);
    const r = await ctx.db.query('select gps_samples, accuracy_m from attendance_records');
    expect(r.rows[0]).toMatchObject({ gps_samples: 3, accuracy_m: 7 });
  });

  it('a noisy fix doesn’t drag a good position outside the fence', async () => {
    const { res } = await markWith([sample(40, 6, 3000), sample(42, 6, 2000), sample(95, 12, 1000)]);
    expect(res.statusCode).toBe(200);
  });

  it('one mock-flagged fix among many refuses the scan', async () => {
    const { res } = await markWith([sample(5, 8, 2000), sample(5, 8, 1000, { mocked: true })]);
    expect(code(res)).toBe('E-MOCK');
  });

  it('a location jumping kilometres in a second refuses the scan', async () => {
    const { res } = await markWith([sample(5, 8, 2000, { east: 9000 }), sample(5, 8, 1000)]);
    expect(code(res)).toBe('E-MOCK');
    expect(res.json().error.rejection.detail).toMatch(/jumped/);
  });

  it('stale fixes are ignored; only stale fixes → stale', async () => {
    const ok = await markWith([sample(300, 8, 120_000), sample(5, 8, 1000)]);
    expect(ok.res.statusCode).toBe(200);
    await ctx.db.query('delete from attendance_records');
    const stale = await markWith([sample(5, 8, 120_000)]);
    expect(code(stale.res)).toBe('E-GPS-STALE');
  });

  it('fixes worse than ±75 m are too imprecise', async () => {
    const { res } = await markWith([sample(5, 80, 1000)]);
    expect(code(res)).toBe('E-GPS-WEAK');
  });
});

describe('impossible travel between scans', () => {
  it('a scan 30 km away from another scan 5 minutes earlier is refused', async () => {
    const first = await markWith([sample(5, 8, 1000)]);
    expect(first.res.statusCode).toBe(200);
    // Move the first record 30 km away (another campus), 5 minutes ago.
    await ctx.db.query(`update attendance_records set lat = lat + 0.27, marked_at = $1`, [new Date(ctx.clock.now - 5 * 60_000)]);
    const second = await markWith([sample(5, 8, 1000)]);
    expect(code(second.res)).toBe('E-MOCK');
    expect(second.res.json().error.rejection.detail).toMatch(/no one travels that fast/);
  });

  it('two classes on the same campus an hour apart are fine', async () => {
    await markWith([sample(5, 8, 1000)]);
    await ctx.db.query(`update attendance_records set lat = lat + 0.01, marked_at = $1`, [new Date(ctx.clock.now - 60 * 60_000)]);
    const second = await markWith([sample(5, 8, 1000)]);
    expect(second.res.statusCode).toBe(200);
  });
});

describe('classroom centre precision', () => {
  it('a centre measured to ±4 m widens the fence by those metres only', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const loc = { ...at(58), accuracyM: 5, mocked: false, capturedAt: ctx.clock.now };
    expect(code(await aarav.call('POST', '/v1/attendance/mark', { qr: liveToken(ctx, s), location: loc }))).toBe('E-GEO');
    await ctx.db.query('update class_sessions set center_accuracy_m = 4 where id = $1', [s.id]);
    expect((await aarav.call('POST', '/v1/attendance/mark', { qr: liveToken(ctx, s), location: loc })).statusCode).toBe(200);
  });
});
