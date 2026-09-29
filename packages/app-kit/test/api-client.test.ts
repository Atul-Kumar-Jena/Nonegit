/**
 * End-to-end: the exact API client the phone runs, over real HTTP, against the
 * real server + PostgreSQL. Only secure storage is replaced by memory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeQrToken, fromB64url, generateKeyPair, type AuthTokens } from '@attendly/protocol';
import { ApiClient, ApiRequestError, normalizeBaseUrl, verifyReceipt, type TokenStore } from '../src/lib/api-core';
import { CENTER, createTestApp, seedBasic, startLiveSession, type Seeded, type TestCtx, liveToken } from '../../../server/test/harness';

let ctx: TestCtx;
let seed: Seeded;
let baseUrl: string;

function memoryTokens(): TokenStore & { value: AuthTokens | null } {
  const s = {
    value: null as AuthTokens | null,
    get: async () => s.value,
    set: async (t: AuthTokens) => void (s.value = t),
    clear: async () => void (s.value = null),
  };
  return s;
}

function phone(now?: () => number) {
  const kp = generateKeyPair();
  const tokens = memoryTokens();
  const lost: string[] = [];
  const client = new ApiClient({
    baseUrl,
    keys: { secretKey: async () => kp.secretKey, publicKey: async () => kp.publicKey },
    tokens,
    onSessionLost: (e) => lost.push(e.code),
    ...(now ? { now } : {}),
  });
  return { client, tokens, lost, kp };
}

const DEVICE = { platform: 'android' as const, model: 'Pixel 8', osVersion: 'Android 15', appVersion: '1.0.0', integrity: { rooted: false, emulator: false } };

async function signIn(p: ReturnType<typeof phone>, email: string) {
  const r = await p.client.requestOtp({ channel: 'email', identifier: email });
  const code = [...ctx.sent].reverse().find((m) => m.to === email)!.code;
  const v = await p.client.verifyOtp(r.challengeId, code, { ...DEVICE, hardwareId: `aid-${Math.random().toString(36).slice(2, 12)}` });
  if (v.status === 'bind_required') await p.client.bind(v.ticket);
  return v;
}

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = ctx.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => ctx?.close());

describe('normalizeBaseUrl', () => {
  it('enforces https except in dev', () => {
    expect(normalizeBaseUrl('https://a.edu/', false)).toBe('https://a.edu');
    expect(normalizeBaseUrl(' https://a.edu/api// ', false)).toBe('https://a.edu/api');
    expect(() => normalizeBaseUrl('http://a.edu', false)).toThrow(/https/);
    expect(normalizeBaseUrl('http://192.168.1.5:4000', true)).toBe('http://192.168.1.5:4000');
    expect(() => normalizeBaseUrl('https://u:p@a.edu', false)).toThrow();
    expect(() => normalizeBaseUrl('not a url', false)).toThrow();
    expect(() => normalizeBaseUrl('https://.....trycloudflare.com', false)).toThrow();
    expect(() => new ApiClient({ baseUrl: 'https://.....x.com', keys: { secretKey: async () => new Uint8Array(32), publicKey: async () => new Uint8Array(32) }, tokens: { get: async () => null, set: async () => {}, clear: async () => {} } })).toThrow();
  });
});

describe('student app ⇄ server', () => {
  it('signs in, binds, loads data and marks attendance with a verified receipt', async () => {
    const p = phone();
    const meta = await p.client.meta();
    const v = await signIn(p, 'aarav@iit.ac.in');
    expect(v.status).toBe('bind_required');
    expect(p.tokens.value).not.toBeNull();

    const dash = await p.client.dashboard();
    expect(dash.user.fullName).toBe('aarav');
    expect((await p.client.subjects()).subjects.map((s) => s.code)).toEqual(['CS-301']);
    expect((await p.client.profile()).device.status).toBe('active');

    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const res = await p.client.mark({ qr: liveToken(ctx, s), location: { ...CENTER, accuracyM: 6, mocked: false, capturedAt: p.client.serverNow() } });
    expect(res.status).toBe('present');
    const pin = { kid: meta.serverKey.kid, publicKey: fromB64url(meta.serverKey.publicKey) };
    expect(verifyReceipt(res, pin)).toBe(true);
    // A different (attacker) key must not verify.
    expect(verifyReceipt(res, { kid: pin.kid, publicKey: generateKeyPair().publicKey })).toBe(false);
    expect(verifyReceipt({ ...res, record: { ...res.record, qrSeq: 99 } }, pin)).toBe(false);
  });

  it('surfaces rejections with their code', async () => {
    const p = phone();
    await signIn(p, 'priya@iit.ac.in');
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const err = await p.client
      .mark({ qr: liveToken(ctx, s), location: { lat: CENTER.lat + 0.01, lng: CENTER.lng, accuracyM: 6, mocked: false, capturedAt: p.client.serverNow() } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe('REJECTED');
    expect(err.rejection.code).toBe('E-GEO');
    expect(err.rejection.detail).toMatch(/m from LH-2/);
  });

  it('refreshes expired access tokens transparently', async () => {
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'Ref', 'ref@iit.ac.in')`, [seed.tenantId]);
    const p = phone(() => ctx.clock.now);
    await signIn(p, 'ref@iit.ac.in');
    const before = p.tokens.value!.accessToken;
    ctx.clock.now += 16 * 60_000; // server + client both move past access expiry
    const prof = await p.client.profile();
    expect(prof.user.fullName).toBe('Ref');
    expect(p.tokens.value!.accessToken).not.toBe(before);
    ctx.clock.now = Date.now();
  });

  it('keeps the session when a refresh is rate-limited (campus NAT burst)', async () => {
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'Burst', 'burst@iit.ac.in')`, [seed.tenantId]);
    const setup = phone(() => ctx.clock.now);
    await signIn(setup, 'burst@iit.ac.in');
    let throttle = true;
    const lost: string[] = [];
    const client = new ApiClient({
      baseUrl,
      keys: { secretKey: async () => setup.kp.secretKey, publicKey: async () => setup.kp.publicKey },
      tokens: setup.tokens,
      now: () => ctx.clock.now,
      onSessionLost: (e) => lost.push(e.code),
      fetchImpl: async (url, init) =>
        throttle && String(url).endsWith('/v1/auth/refresh')
          ? new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many attempts.' } }), { status: 429 })
          : fetch(url, init),
    });
    ctx.clock.now += 16 * 60_000;
    const err = await client.profile().catch((e) => e);
    expect(err.code).toBe('RATE_LIMITED');
    expect(lost).toEqual([]);
    expect(setup.tokens.value).not.toBeNull(); // still signed in
    throttle = false;
    expect((await client.profile()).user.fullName).toBe('Burst'); // next try refreshes fine
    ctx.clock.now = Date.now();
  });

  it('recovers from a badly wrong phone clock', async () => {
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'Skew', 'skew@iit.ac.in')`, [seed.tenantId]);
    const setup = phone();
    await signIn(setup, 'skew@iit.ac.in');
    // Same identity, but a client whose clock is 10 minutes behind and has never synced.
    const skewed = new ApiClient({
      baseUrl,
      keys: { secretKey: async () => setup.kp.secretKey, publicKey: async () => setup.kp.publicKey },
      tokens: setup.tokens,
      now: () => Date.now() - 10 * 60_000,
    });
    expect(skewed.clockDriftMs()).toBeNull();
    const prof = await skewed.profile();
    expect(prof.user.fullName).toBe('Skew');
    expect(Math.abs(skewed.clockDriftMs()! + 10 * 60_000)).toBeLessThan(5_000);
  });

  it('reports a lost session when the device is revoked', async () => {
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', 'Rev', 'rev@iit.ac.in')`, [seed.tenantId]);
    const p = phone();
    await signIn(p, 'rev@iit.ac.in');
    await ctx.db.query(`update devices set status = 'revoked' where user_id = (select id from users where email = 'rev@iit.ac.in')`);
    const err = await p.client.profile().catch((e) => e);
    expect(err.code).toBe('DEVICE_REVOKED');
    expect(p.lost).toEqual(['DEVICE_REVOKED']);
    expect(p.tokens.value).toBeNull();
  });

  it('maps network failures and timeouts to friendly errors', async () => {
    const dead = new ApiClient({
      baseUrl: 'http://127.0.0.1:9',
      keys: { secretKey: async () => new Uint8Array(32), publicKey: async () => new Uint8Array(32) },
      tokens: memoryTokens(),
    });
    const e1 = await dead.meta().catch((e) => e);
    expect(e1.code).toBe('NETWORK');
    expect(e1.transient).toBe(true);

    const slow = new ApiClient({
      baseUrl,
      keys: { secretKey: async () => new Uint8Array(32), publicKey: async () => new Uint8Array(32) },
      tokens: memoryTokens(),
      timeoutMs: 50,
      fetchImpl: (url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    });
    const e2 = await slow.meta().catch((e) => e);
    expect(e2.code).toBe('TIMEOUT');
  });

  it('refuses responses that break the contract', async () => {
    const liar = new ApiClient({
      baseUrl,
      keys: { secretKey: async () => new Uint8Array(32), publicKey: async () => new Uint8Array(32) },
      tokens: memoryTokens(),
      fetchImpl: async () => new Response(JSON.stringify({ name: 'Attendly', apiVersion: 1 }), { status: 200 }),
    });
    const e = await liar.meta().catch((x) => x);
    expect(e.code).toBe('BAD_RESPONSE');
  });
});
