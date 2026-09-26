import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, stepOf, totpAt, verifyTotp } from '../src/lib/totp';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';
import { verifyAuditChain } from '../src/lib/audit';

let ctx: TestCtx;
let seed: Seeded;
let admin: TestDevice;
let aarav: TestDevice;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const codeFor = (secret: string, offsetSteps = 0) => totpAt(base32Decode(secret), stepOf(ctx.clock.now) + offsetSteps);

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'admin', 'HOD', 'hod@iit.ac.in')`, [seed.tenantId]);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'Dr. Kumar', 'kumar@iit.ac.in')`, [seed.tenantId]);
  admin = new TestDevice(ctx);
  aarav = new TestDevice(ctx);
  await admin.signIn('hod@iit.ac.in');
  await aarav.signIn('aarav@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('TOTP', () => {
  it('matches the RFC 6238 test vector', () => {
    // RFC 6238 appendix B, SHA-1, T = 59 s → 94287082 (8 digits); 6 digits → 287082.
    const secret = Buffer.from('12345678901234567890');
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000, null)).toBe(1);
    expect(verifyTotp(secret, '287082', 59_000, 1)).toBeNull(); // never twice
  });
});

describe('sign in with an authenticator app', () => {
  it('self-service: set up, confirm with a first code, then sign-in asks for the app’s code (nothing is sent)', async () => {
    expect(ok(await aarav.call('GET', '/v1/me/authenticator')).enabled).toBe(false);
    const setup = ok(await aarav.call('POST', '/v1/me/authenticator/setup', {}));
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Attendly:aarav%40iit\.ac\.in\?secret=[A-Z2-7]+&issuer=Attendly/);
    expect(setup.active).toBe(false);
    expect((await aarav.call('POST', '/v1/me/authenticator/confirm', { code: '000000' })).statusCode).toBe(400);
    ok(await aarav.call('POST', '/v1/me/authenticator/confirm', { code: codeFor(setup.secret) }));
    expect(ok(await aarav.call('GET', '/v1/me/authenticator')).enabled).toBe(true);
    // The secret is stored encrypted, never in the clear.
    const row = (await ctx.db.query<{ totp_secret_enc: Buffer }>('select totp_secret_enc from users where id = $1', [seed.studentId])).rows[0]!;
    expect(row.totp_secret_enc.includes(base32Decode(setup.secret))).toBe(false);

    ctx.clock.now += 60_000;
    const phone = new TestDevice(ctx);
    const sent = ctx.sent.length;
    const r = ok(await phone.requestOtp('aarav@iit.ac.in'));
    expect(r.method).toBe('authenticator');
    expect(ctx.sent.length).toBe(sent);
    expect((await phone.verifyOtp(r.challengeId, '123456')).statusCode).toBe(400);
    const v = ok(await phone.verifyOtp(r.challengeId, codeFor(setup.secret)));
    expect(v.status).toBe('device_mismatch'); // right code; the account is bound to the other phone
    // The same code can't be used again.
    ctx.clock.now += 31_000;
    const again = ok(await phone.requestOtp('aarav@iit.ac.in'));
    expect((await phone.verifyOtp(again.challengeId, totpAt(base32Decode(setup.secret), stepOf(ctx.clock.now - 31_000)))).statusCode).toBe(400);
  });

  it('turning it off needs a current code; then emailed codes are back', async () => {
    const setup = ok(await aarav.call('POST', '/v1/me/authenticator/setup', {}));
    ok(await aarav.call('POST', '/v1/me/authenticator/confirm', { code: codeFor(setup.secret) }));
    ctx.clock.now += 60_000;
    expect((await aarav.call('POST', '/v1/me/authenticator/disable', { code: '111111' })).statusCode).toBe(400);
    expect(ok(await aarav.call('POST', '/v1/me/authenticator/disable', { code: codeFor(setup.secret) })).enabled).toBe(false);
    ctx.clock.now += 31_000;
    expect(ok(await new TestDevice(ctx).requestOtp('aarav@iit.ac.in')).method).toBe('email');
  });

  it('an admin issues one in person (live at once), and can remove it; teachers and students can’t', async () => {
    const kumar = (await ctx.db.query<{ id: string }>(`select id from users where email = 'kumar@iit.ac.in'`)).rows[0]!.id;
    expect((await aarav.call('POST', `/v1/staff/people/${kumar}/authenticator`, {})).statusCode).toBe(403);
    const issued = ok(await admin.call('POST', `/v1/staff/people/${kumar}/authenticator`, {}));
    expect(issued.active).toBe(true);
    expect(ok(await admin.call('GET', `/v1/staff/people/${kumar}`)).authenticator).toBe(true);

    ctx.clock.now += 31_000;
    const t = new TestDevice(ctx);
    const r = ok(await t.requestOtp('kumar@iit.ac.in'));
    expect(r.method).toBe('authenticator');
    const v = ok(await t.verifyOtp(r.challengeId, codeFor(issued.secret)));
    expect(v.status).toBe('bind_required');
    expect((await t.bind(v.ticket)).statusCode).toBe(200);

    // Other admins' authenticators are theirs to manage.
    const hod2 = (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'admin', 'HOD 2', 'hod2@iit.ac.in') returning id`, [seed.tenantId])).rows[0]!.id;
    expect((await admin.call('POST', `/v1/staff/people/${hod2}/authenticator`, {})).statusCode).toBe(403);
    // Other institutions are invisible.
    expect((await admin.call('POST', `/v1/staff/people/${seed.outsiderId}/authenticator`, {})).statusCode).toBe(404);

    ok(await admin.call('POST', `/v1/staff/people/${kumar}/authenticator/remove`, {}));
    ctx.clock.now += 31_000;
    expect(ok(await new TestDevice(ctx).requestOtp('kumar@iit.ac.in')).method).toBe('email');
    const actions = (await ctx.db.query<{ action: string }>(`select action from audit_log where action like 'auth.authenticator%'`)).rows.map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.authenticator_enable', 'auth.authenticator_disable', 'auth.authenticator_issue', 'auth.authenticator_remove']));
    expect((await verifyAuditChain(ctx.db)).ok).toBe(true);
  });
});
