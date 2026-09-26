import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { toB64url } from '@attendly/protocol';
import { loadConfig } from '../src/config';
import { seedDemo } from '../src/seed';
import { TestDevice, createTestApp, type TestCtx } from './harness';

let ctx: TestCtx;
const REAL = { aarav: 'real.aarav@iit.ac.in', priya: 'real.priya@iit.ac.in' };
beforeAll(async () => {
  ctx = await createTestApp({ DEMO_INSTANT_LOGIN: 'true' });
  await seedDemo(ctx.db, ctx.deps.config, { log: () => undefined });
  const t = await ctx.db.query<{ id: string }>(`insert into tenants(slug, name, email_domains, term_start) values ('iit', 'IIT Test', '{iit.ac.in}', current_date - 30) returning id`);
  for (const [i, email] of Object.values(REAL).entries())
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email, roll_no) values ($1, 'student', $2, $2, $3)`, [t.rows[0]!.id, email, `R${i}`]);
});
afterAll(async () => ctx?.close());

async function instantSignIn(d: TestDevice, email: string) {
  const r = await d.requestOtp(email);
  expect(r.statusCode).toBe(200);
  const code = r.json().instantCode as string;
  expect(code).toMatch(/^\d{6}$/);
  return d.verifyOtp(r.json().challengeId, code);
}

describe('demo mode', () => {
  it('is on by default only while production has no real code delivery', () => {
    const base = { DATABASE_URL: 'postgres://x', SERVER_SIGNING_KEY: toB64url(new Uint8Array(randomBytes(32))), TOKEN_PEPPER: toB64url(new Uint8Array(randomBytes(32))) };
    expect(loadConfig({ ...base, NODE_ENV: 'production', OTP_DELIVERY: 'console' }).demoInstantLogin).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production', OTP_DELIVERY: 'console' }).seedDemo).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production', OTP_DELIVERY: 'smtp', SMTP_URL: 'smtp://x' }).demoInstantLogin).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'production', OTP_DELIVERY: 'console', DEMO_INSTANT_LOGIN: 'false' }).demoInstantLogin).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).demoInstantLogin).toBe(false);
  });

  it('lists the demo accounts in /v1/meta', async () => {
    const meta = (await ctx.app.inject({ method: 'GET', url: '/v1/meta' })).json();
    expect(meta.demo.instantLogin).toBe(true);
    expect(meta.demo.institution).toBe('Demo Institute of Technology');
    const emails = meta.demo.accounts.map((a: { email: string }) => a.email);
    expect(emails).toContain('iyer@demo.attendly.app');
    expect(emails).toContain('aarav@demo.attendly.app');
    expect(emails).toContain('root@demo.attendly.app');
    // Only demo accounts are ever listed.
    expect(emails.every((e: string) => e.endsWith('@demo.attendly.app'))).toBe(true);
    expect(meta.demo.accounts[0].role).toBe('admin');
  });

  it('signs demo accounts in without a code, and never sends one', async () => {
    const d = new TestDevice(ctx);
    const sentBefore = ctx.sent.length;
    const v = await instantSignIn(d, 'aarav@demo.attendly.app');
    expect(v.json().status).toBe('bind_required');
    expect((await d.bind(v.json().ticket)).statusCode).toBe(200);
    expect(ctx.sent.length).toBe(sentBefore);
    // Repeated sign-ins are not throttled for demo accounts.
    for (let i = 0; i < 3; i++) expect((await d.requestOtp('aarav@demo.attendly.app')).statusCode).toBe(200);
  });

  it('keeps real accounts on one-time codes (no instant code, normal throttling)', async () => {
    const d = new TestDevice(ctx);
    const r = await d.requestOtp(REAL.aarav);
    expect(r.statusCode).toBe(200);
    expect(r.json().instantCode).toBeUndefined();
    expect(ctx.sent.at(-1)?.to).toBe(REAL.aarav);
    expect((await d.requestOtp(REAL.aarav)).statusCode).toBe(429);
    // Unknown non-demo addresses still get the indistinguishable answer.
    expect((await d.requestOtp('nobody@example.com')).statusCode).toBe(200);
    expect((await d.requestOtp('nobody@demo.attendly.app')).statusCode).toBe(404);
  });

  it('lets a demo account move to another phone, and a phone switch between demo accounts', async () => {
    const phoneA = new TestDevice(ctx);
    const first = await instantSignIn(phoneA, 'priya@demo.attendly.app');
    expect((await phoneA.bind(first.json().ticket)).statusCode).toBe(200);
    expect((await phoneA.call('GET', '/v1/me/dashboard')).statusCode).toBe(200);

    const phoneB = new TestDevice(ctx);
    const moved = await instantSignIn(phoneB, 'priya@demo.attendly.app');
    expect(moved.json().status).toBe('bind_required');
    expect((await phoneB.bind(moved.json().ticket)).statusCode).toBe(200);
    // The old phone's session is gone.
    expect((await phoneA.call('GET', '/v1/me/dashboard')).statusCode).toBe(401);

    // …but phoneB can't become a second demo student's phone: one phone, one student, even in the demo.
    const other = await instantSignIn(phoneB, 'rohan@demo.attendly.app');
    expect(other.json().status).toBe('bind_required');
    expect((await phoneB.bind(other.json().ticket)).statusCode).toBe(409);
    // Demo staff may still share a phone (the guided tour signs in as several teachers on one phone).
    const staffPhone = new TestDevice(ctx);
    for (const email of ['banerjee@demo.attendly.app', 'khanna@demo.attendly.app']) {
      const s = await instantSignIn(staffPhone, email);
      expect(s.json().status).toBe('bind_required');
      expect((await staffPhone.bind(s.json().ticket)).statusCode).toBe(200);
    }
  });

  it('never hands over a real account’s phone', async () => {
    const d = new TestDevice(ctx);
    await d.signIn(REAL.priya);
    ctx.clock.now += 31_000; // past the resend wait
    const other = new TestDevice(ctx);
    const r = await other.requestOtp(REAL.priya);
    const v = await other.verifyOtp(r.json().challengeId, other.lastCode(REAL.priya));
    expect(v.json().status).toBe('device_mismatch');
    // …and a demo account can't take over a phone bound to a real person.
    const grab = await instantSignIn(d, 'vikram@demo.attendly.app');
    expect(grab.json().status).toBe('bind_required');
    expect((await d.bind(grab.json().ticket)).statusCode).toBe(409);
  });
});
