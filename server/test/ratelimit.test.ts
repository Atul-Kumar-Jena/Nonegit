import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx, liveToken } from './harness';

let ctx: TestCtx;
let seed: Seeded;

beforeAll(async () => {
  ctx = await createTestApp({}, { rateLimit: true });
  seed = await seedBasic(ctx.db);
});
afterAll(async () => ctx?.close());

describe('rate limiting', () => {
  it('limits marks per device, so classmates behind one campus IP are unaffected', async () => {
    const a = new TestDevice(ctx);
    const b = new TestDevice(ctx);
    await a.signIn('aarav@iit.ac.in');
    await b.signIn('priya@iit.ac.in');
    // A scheduled (not live) session gives a cheap, non-suspicious rejection.
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled', startedAt: ctx.clock.now + 2 * 3_600_000 });
    const mark = (d: TestDevice) =>
      d.call('POST', '/v1/attendance/mark', { qr: liveToken(ctx, s), location: { ...at(5), accuracyM: 8, mocked: false, capturedAt: ctx.clock.now } });
    for (let i = 0; i < 30; i++) expect((await mark(a)).statusCode).toBe(422);
    const limited = await mark(a);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    // Same IP (all inject() calls share 127.0.0.1), different device: not limited.
    expect((await mark(b)).statusCode).toBe(422);
  });

  it('meta advertises the available sign-in channels', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/meta' });
    expect(r.json().channels).toEqual(['email', 'phone']);
  });
});
