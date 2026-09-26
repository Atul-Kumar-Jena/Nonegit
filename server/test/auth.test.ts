import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, randomToken, signB64, loginProofString, OtpVerifyResponse, BindResponse, MetaResponse } from '@attendly/protocol';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
});
afterAll(async () => ctx?.close());
beforeEach(() => {
  ctx.clock.now = Date.now();
});

describe('meta', () => {
  it('publishes the server receipt key and time', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/meta' });
    expect(r.statusCode).toBe(200);
    const m = MetaResponse.parse(r.json());
    expect(m.serverKey.kid).toMatch(/^srv-/);
    expect(r.headers['x-server-time']).toBeDefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('returns a structured 404', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects invalid JSON and oversize bodies cleanly', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/auth/otp/request', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('BAD_REQUEST');
    const big = await ctx.app.inject({ method: 'POST', url: '/v1/auth/otp/request', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ x: 'a'.repeat(20_000) }) });
    expect(big.statusCode).toBe(413);
  });
});

describe('OTP sign-in and device binding', () => {
  it('full happy path: request → verify → bind → authenticated call', async () => {
    const phone = new TestDevice(ctx);
    const req = await phone.requestOtp('Aarav@IIT.ac.in');
    expect(req.statusCode).toBe(200);
    expect(req.json().destination).toBe('aa•••@iit.ac.in');
    const code = phone.lastCode('aarav@iit.ac.in');
    expect(code).toMatch(/^\d{6}$/);

    const v = await phone.verifyOtp(req.json().challengeId, code);
    expect(v.statusCode).toBe(200);
    const verified = OtpVerifyResponse.parse(v.json());
    expect(verified.status).toBe('bind_required');
    if (verified.status !== 'bind_required') return;

    const b = await phone.bind(verified.ticket);
    expect(b.statusCode).toBe(200);
    const bound = BindResponse.parse(b.json());
    expect(bound.device.status).toBe('active');
    expect(bound.user.institution.slug).toBe('iit');

    const dash = await phone.call('GET', '/v1/me/dashboard');
    expect(dash.statusCode).toBe(200);

    // Same phone signing in again gets tokens straight away.
    const again = new TestDevice(ctx);
    Object.assign(again, { keys: phone.keys });
    const r2 = await again.requestOtp('aarav@iit.ac.in');
    expect(r2.statusCode).toBe(429); // resend throttle (30s)
    ctx.clock.now += 31_000;
    const r3 = await again.requestOtp('aarav@iit.ac.in');
    expect(r3.statusCode).toBe(200);
    const v3 = await again.verifyOtp(r3.json().challengeId, again.lastCode('aarav@iit.ac.in'));
    expect(v3.json().status).toBe('ok');
  });

  it('refuses unknown institutions but hides whether a user exists', async () => {
    const phone = new TestDevice(ctx);
    const unknownInst = await phone.requestOtp('someone@gmail.com');
    expect(unknownInst.statusCode).toBe(404);
    expect(unknownInst.json().error.code).toBe('INSTITUTION_UNKNOWN');

    const before = ctx.sent.length;
    const ghost = await phone.requestOtp('ghost@iit.ac.in');
    expect(ghost.statusCode).toBe(200);
    expect(Object.keys(ghost.json()).sort()).toEqual(['challengeId', 'destination', 'expiresAt', 'resendAfterSec']);
    expect(ctx.sent.length).toBe(before); // nothing was sent
    // …and no code can ever verify it.
    const v = await phone.verifyOtp(ghost.json().challengeId, '000000');
    expect(v.json().error.code).toBe('OTP_INVALID');
  });

  it('locks a challenge after 5 wrong codes and never accepts it afterwards', async () => {
    const phone = new TestDevice(ctx);
    const r = await phone.requestOtp('+919000000001', 'phone');
    expect(r.statusCode).toBe(200);
    const good = phone.lastCode('+919000000001');
    const wrong = good === '000000' ? '111111' : '000000';
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push((await phone.verifyOtp(r.json().challengeId, wrong)).json().error.code);
    expect(codes).toEqual(['OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID', 'OTP_LOCKED']);
    const late = await phone.verifyOtp(r.json().challengeId, good);
    expect(late.json().error.code).toBe('OTP_LOCKED');
  });

  it('expires codes after 5 minutes and makes them single-use', async () => {
    const phone = new TestDevice(ctx);
    ctx.clock.now += 3_600_000; // escape the per-identifier throttle from earlier tests
    const r = await phone.requestOtp('priya@iit.ac.in');
    const code = phone.lastCode('priya@iit.ac.in');
    ctx.clock.now += 5 * 60_000 + 1;
    expect((await phone.verifyOtp(r.json().challengeId, code)).json().error.code).toBe('OTP_EXPIRED');

    ctx.clock.now += 31_000;
    const r2 = await phone.requestOtp('priya@iit.ac.in');
    const code2 = phone.lastCode('priya@iit.ac.in');
    expect((await phone.verifyOtp(r2.json().challengeId, code2)).statusCode).toBe(200);
    expect((await phone.verifyOtp(r2.json().challengeId, code2)).json().error.code).toBe('OTP_EXPIRED');
  });

  it('requires proof of possession of the device key', async () => {
    const phone = new TestDevice(ctx);
    ctx.clock.now += 7_200_000;
    const r = await phone.requestOtp('zed@other.edu');
    const code = phone.lastCode('zed@other.edu');
    const stranger = generateKeyPair();
    const forged = signB64(loginProofString({ challengeId: r.json().challengeId, publicKeyB64: phone.publicKeyB64 }), stranger.secretKey);
    const v = await phone.verifyOtp(r.json().challengeId, code, forged);
    expect(v.statusCode).toBe(401);
    expect(v.json().error.code).toBe('BAD_SIGNATURE');
  });

  it('refuses rooted devices and emulators', async () => {
    ctx.clock.now += 10_800_000;
    const rooted = new TestDevice(ctx, { integrity: { rooted: true, emulator: false } });
    const r = await rooted.requestOtp('zed@other.edu');
    const v = await rooted.verifyOtp(r.json().challengeId, rooted.lastCode('zed@other.edu'));
    expect(v.statusCode).toBe(403);
    expect(v.json().error.code).toBe('INTEGRITY');

    ctx.clock.now += 31_000;
    const emu = new TestDevice(ctx, { integrity: { rooted: false, emulator: true } });
    const r2 = await emu.requestOtp('zed@other.edu');
    const v2 = await emu.verifyOtp(r2.json().challengeId, emu.lastCode('zed@other.edu'));
    expect(v2.json().error.code).toBe('INTEGRITY');

    ctx.clock.now += 31_000;
    const web = new TestDevice(ctx, { platform: 'web' });
    const r3 = await web.requestOtp('zed@other.edu');
    const v3 = await web.verifyOtp(r3.json().challengeId, web.lastCode('zed@other.edu'));
    expect(v3.json().error.code).toBe('INTEGRITY');
  });

  it('binding tickets are single-use and cannot be used by another key', async () => {
    ctx.clock.now += 14_400_000;
    const phone = new TestDevice(ctx);
    const r = await phone.requestOtp('zed@other.edu');
    const v = await phone.verifyOtp(r.json().challengeId, phone.lastCode('zed@other.edu'));
    const ticket = v.json().ticket as string;
    const thief = new TestDevice(ctx);
    const stolen = await thief.bind(ticket);
    expect(stolen.json().error.code).toBe('BAD_SIGNATURE');
    expect((await phone.bind(ticket)).statusCode).toBe(200);
    expect((await phone.bind(ticket)).json().error.code).toBe('TICKET_INVALID');
    expect((await phone.bind(randomToken(32))).json().error.code).toBe('TICKET_INVALID');
  });
});

describe('one student, one device', () => {
  it('a second phone gets device_mismatch and can only file a rebind request', async () => {
    ctx.clock.now += 20_000_000;
    const first = new TestDevice(ctx);
    const email = 'priya@iit.ac.in';
    await first.signIn(email);

    ctx.clock.now += 31_000;
    const second = new TestDevice(ctx, { model: 'iPhone 15 Pro', platform: 'ios' });
    const r = await second.requestOtp(email);
    const v = await second.verifyOtp(r.json().challengeId, second.lastCode(email));
    const body = OtpVerifyResponse.parse(v.json());
    expect(body.status).toBe('device_mismatch');
    if (body.status !== 'device_mismatch') return;
    expect(body.boundDevice.model).toBe('Pixel 8');
    expect(body.pendingRequest).toBeNull();

    // A bind ticket can't be used — this is a rebind ticket.
    expect((await second.bind(body.ticket)).json().error.code).toBe('TICKET_INVALID');

    const { bindProofString, signB64: s } = await import('@attendly/protocol');
    const proof = s(bindProofString({ ticket: body.ticket, publicKeyB64: second.publicKeyB64, purpose: 'rebind' }), second.keys.secretKey);
    const req = await ctx.app.inject({ method: 'POST', url: '/v1/devices/rebind-request', payload: { ticket: body.ticket, proof, reason: 'Lost previous phone' } });
    expect(req.statusCode).toBe(200);
    expect(req.json().status).toBe('pending');

    const { rows } = await ctx.db.query(`select kind, status, reason from device_requests where user_id = $1`, [seed.student2Id]);
    expect(rows).toEqual([{ kind: 'rebind', status: 'pending', reason: 'Lost previous phone' }]);

    // First phone still works.
    expect((await first.call('GET', '/v1/me/profile')).statusCode).toBe(200);
  });

  it('a phone already bound to one student cannot be bound to another', async () => {
    ctx.clock.now += 20_000_000;
    const shared = new TestDevice(ctx);
    await shared.signIn('zed@other.edu').catch(() => undefined); // zed may already have a device from earlier
    const phoneKeys = generateKeyPair();
    const a = new TestDevice(ctx);
    Object.assign(a, { keys: phoneKeys });
    // Aarav may already be bound; use the outsider-free path: create a fresh student.
    const u = await ctx.db.query<{ id: string }>(
      `insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'N', 'new1@iit.ac.in') returning id`,
      [seed.tenantId],
    );
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'M', 'new2@iit.ac.in')`, [seed.tenantId]);
    expect(u.rows[0]).toBeDefined();
    await a.signIn('new1@iit.ac.in');
    const b = new TestDevice(ctx);
    Object.assign(b, { keys: phoneKeys });
    const r = await b.requestOtp('new2@iit.ac.in');
    const v = await b.verifyOtp(r.json().challengeId, b.lastCode('new2@iit.ac.in'));
    const res = await b.bind(v.json().ticket);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });
});

describe('signed requests', () => {
  let phone: TestDevice;
  beforeAll(async () => {
    ctx.clock.now = Date.now() + 40_000_000;
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'Sig', 'sig@iit.ac.in')`, [seed.tenantId]);
    phone = new TestDevice(ctx);
    await phone.signIn('sig@iit.ac.in');
  });
  beforeEach(() => {
    ctx.clock.now = Date.now() + 40_000_000;
  });

  it('rejects missing token, missing signature and garbage', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me/profile' })).json().error.code).toBe('UNAUTHENTICATED');
    const noSig = await ctx.app.inject({ method: 'GET', url: '/v1/me/profile', headers: { authorization: `Bearer ${phone.accessToken}` } });
    expect(noSig.json().error.code).toBe('BAD_SIGNATURE');
    const junk = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me/profile',
      headers: { authorization: `Bearer ${phone.accessToken}`, 'x-attendly-ts': 'x', 'x-attendly-nonce': '!', 'x-attendly-sig': '?' },
    });
    expect(junk.json().error.code).toBe('BAD_SIGNATURE');
  });

  it('rejects a stolen access token used without the device key', async () => {
    const thiefKey = generateKeyPair().secretKey;
    const r = await phone.call('GET', '/v1/me/profile', undefined, { key: thiefKey });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('BAD_SIGNATURE');
  });

  it('rejects a tampered body', async () => {
    const r = await phone.call('POST', '/v1/me/device-reset', { reason: 'new phone' }, { tamper: JSON.stringify({ reason: 'evil' }) });
    expect(r.json().error.code).toBe('BAD_SIGNATURE');
  });

  it('rejects a replayed nonce', async () => {
    const nonce = randomToken(16);
    expect((await phone.call('GET', '/v1/me/profile', undefined, { nonce })).statusCode).toBe(200);
    const replay = await phone.call('GET', '/v1/me/profile', undefined, { nonce });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('REPLAY');
  });

  it('rejects signatures for a different path (no request splicing)', async () => {
    const headers = phone.signedHeaders('GET', '/v1/me/dashboard', '');
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/me/profile', headers: { ...headers, authorization: `Bearer ${phone.accessToken}` } });
    expect(r.json().error.code).toBe('BAD_SIGNATURE');
  });

  it('rejects stale or future timestamps', async () => {
    const r = await phone.call('GET', '/v1/me/profile', undefined, { ts: ctx.clock.now - 120_000 });
    expect(r.json().error.code).toBe('CLOCK_SKEW');
    const f = await phone.call('GET', '/v1/me/profile', undefined, { ts: ctx.clock.now + 120_000 });
    expect(f.json().error.code).toBe('CLOCK_SKEW');
  });

  it('expires access tokens after 15 minutes; refresh rotates them', async () => {
    ctx.clock.now += 16 * 60_000;
    expect((await phone.call('GET', '/v1/me/profile')).json().error.code).toBe('TOKEN_EXPIRED');
    const oldRefresh = phone.refreshToken!;
    const oldAccess = phone.accessToken!;
    const r = await phone.refresh();
    expect(r.statusCode).toBe(200);
    phone.adopt(r.json());
    expect(phone.accessToken).not.toBe(oldAccess);
    expect((await phone.call('GET', '/v1/me/profile')).statusCode).toBe(200);
    // Old access token is dead even though not yet expired.
    expect((await phone.call('GET', '/v1/me/profile', undefined, { token: oldAccess })).statusCode).toBe(401);

    // Retrying the old refresh within the grace window (lost response) re-issues…
    const retry = await phone.refresh(oldRefresh);
    expect(retry.statusCode).toBe(200);
    // …and retires the pair issued a moment ago.
    expect((await phone.call('GET', '/v1/me/profile')).statusCode).toBe(401);
    phone.adopt(retry.json());
    expect((await phone.call('GET', '/v1/me/profile')).statusCode).toBe(200);

    // Reuse long after rotation = theft signal: whole family revoked.
    ctx.clock.now += 5 * 60_000;
    const reuse = await phone.refresh(oldRefresh);
    expect(reuse.statusCode).toBe(401);
    expect((await phone.call('GET', '/v1/me/profile')).statusCode).toBe(401);
    expect((await phone.refresh()).statusCode).toBe(401);
  });

  it('refresh also requires the device key', async () => {
    const p2 = new TestDevice(ctx);
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'R', 'r@iit.ac.in')`, [seed.tenantId]);
    await p2.signIn('r@iit.ac.in');
    const thief = new TestDevice(ctx);
    const r = await thief.refresh(p2.refreshToken);
    expect(r.json().error.code).toBe('BAD_SIGNATURE');
    expect((await p2.refresh()).statusCode).toBe(200);
  });

  it('logout revokes the session', async () => {
    const p3 = new TestDevice(ctx);
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'L', 'l@iit.ac.in')`, [seed.tenantId]);
    await p3.signIn('l@iit.ac.in');
    expect((await p3.call('POST', '/v1/auth/logout', {})).statusCode).toBe(200);
    expect((await p3.call('GET', '/v1/me/profile')).statusCode).toBe(401);
    expect((await p3.refresh()).statusCode).toBe(401);
  });

  it('suspended accounts and revoked devices lose access immediately', async () => {
    const p4 = new TestDevice(ctx);
    const u = await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'S', 's@iit.ac.in') returning id`, [seed.tenantId]);
    await p4.signIn('s@iit.ac.in');
    await ctx.db.query(`update users set status = 'suspended' where id = $1`, [u.rows[0]!.id]);
    expect((await p4.call('GET', '/v1/me/profile')).json().error.code).toBe('ACCOUNT_SUSPENDED');
    await ctx.db.query(`update users set status = 'active' where id = $1`, [u.rows[0]!.id]);
    await ctx.db.query(`update devices set status = 'revoked' where user_id = $1`, [u.rows[0]!.id]);
    expect((await p4.call('GET', '/v1/me/profile')).json().error.code).toBe('DEVICE_REVOKED');
  });

  it('non-students cannot use student endpoints', async () => {
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'admin', 'Prof', 'prof@iit.ac.in')`, [seed.tenantId]);
    const p = new TestDevice(ctx);
    await p.signIn('prof@iit.ac.in');
    expect((await p.call('GET', '/v1/me/dashboard')).statusCode).toBe(403);
  });
});

describe('device reset requests', () => {
  it('allows one pending request and at most the per-term limit', async () => {
    ctx.clock.now = Date.now() + 60_000_000;
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'D', 'd@iit.ac.in')`, [seed.tenantId]);
    const p = new TestDevice(ctx);
    await p.signIn('d@iit.ac.in');
    const r1 = await p.call('POST', '/v1/me/device-reset', { reason: 'Switching phones' });
    expect(r1.statusCode).toBe(200);
    expect((await p.call('POST', '/v1/me/device-reset', { reason: 'again' })).json().error.code).toBe('CONFLICT');
    await ctx.db.query(`update device_requests set status = 'denied' where id = $1`, [r1.json().requestId]);
    expect((await p.call('POST', '/v1/me/device-reset', { reason: 'second' })).statusCode).toBe(200);
    await ctx.db.query(`update device_requests set status = 'denied' where status = 'pending'`);
    const r3 = await p.call('POST', '/v1/me/device-reset', { reason: 'third' });
    expect(r3.statusCode).toBe(403);
    expect(r3.json().error.code).toBe('LIMIT_REACHED');
    const prof = await p.call('GET', '/v1/me/profile');
    expect(prof.json().resetRequests).toMatchObject({ used: 2, limit: 2, pending: null });
    expect((await p.call('POST', '/v1/me/device-reset', { reason: '' })).json().error.code).toBe('BAD_REQUEST');
  });
});
