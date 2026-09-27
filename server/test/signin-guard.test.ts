import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
});
afterAll(async () => ctx?.close());

const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

describe('guessing sign-in codes', () => {
  it('10 wrong codes a day across several codes locks sign-in and alerts the owner', async () => {
    const owner = new TestDevice(ctx);
    await owner.signIn('aarav@iit.ac.in');
    const attacker = new TestDevice(ctx, { hardwareId: 'attacker-phone' });
    let tries = 0;
    for (let round = 0; round < 3 && tries < 10; round++) {
      ctx.clock.now += 31_000;
      const r = await attacker.requestOtp('aarav@iit.ac.in');
      expect(r.statusCode).toBe(200);
      const code = attacker.lastCode('aarav@iit.ac.in');
      for (let i = 0; i < 5 && tries < 10; i++, tries++) {
        const v = await attacker.verifyOtp(r.json().challengeId, wrong(code));
        expect(v.statusCode).toBeGreaterThanOrEqual(400);
      }
    }
    // Even the right code no longer works today, and no new code is sent.
    ctx.clock.now += 31_000;
    const again = await attacker.requestOtp('aarav@iit.ac.in');
    expect(again.statusCode).toBe(429);
    expect(again.json().error.message).toMatch(/locked for 24 hours/);

    const alerts = await ctx.db.query(`select title from notifications where user_id = $1 and kind = 'security' order by created_at`, [seed.studentId]);
    expect(alerts.rows.map((r) => r.title)).toEqual(['Wrong sign-in codes for your account', 'Sign-in locked for 24 hours']);
    const audit = await ctx.db.query(`select action from audit_log where action in ('auth.wrong_codes', 'auth.locked') order by id`);
    expect(audit.rows.map((r) => r.action)).toEqual(['auth.wrong_codes', 'auth.locked']);

    // A day later it works again.
    ctx.clock.now += 24 * 3_600_000 + 60_000;
    expect((await attacker.requestOtp('aarav@iit.ac.in')).statusCode).toBe(200);
  });

  it('a code requested earlier can’t be used to keep guessing past the budget', async () => {
    const d = new TestDevice(ctx, { hardwareId: 'x-phone' });
    const ids: string[] = [];
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      ctx.clock.now += 31_000;
      ids.push((await d.requestOtp('priya@iit.ac.in')).json().challengeId);
      codes.push(d.lastCode('priya@iit.ac.in'));
    }
    for (let i = 0; i < 5; i++) await d.verifyOtp(ids[0]!, wrong(codes[0]!));
    for (let i = 0; i < 5; i++) await d.verifyOtp(ids[1]!, wrong(codes[1]!));
    const right = await d.verifyOtp(ids[2]!, codes[2]!);
    expect(right.statusCode).toBe(429);
    expect(right.json().error.message).toMatch(/locked for 24 hours/);
  });
});
