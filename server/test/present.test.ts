import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { PRESENT_PAIR_PREFIX, currentQrSeq, normalizePresentCode, presentCodeFromScan, seqLabel, toB64url } from '@attendly/protocol';
import { createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';
import { verifyAuditChain } from '../src/lib/audit';
import { describeDevice } from '../src/routes/present';

let ctx: TestCtx;
let seed: Seeded;
let teacher: TestDevice;
let otherTeacher: TestDevice;
let student: TestDevice;

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function pair(ua = CHROME_WIN) {
  const r = await ctx.app.inject({ method: 'POST', url: '/v1/present/pair', payload: {}, headers: { 'user-agent': ua } });
  expect(r.statusCode).toBe(200);
  return r.json() as { pairingId: string; code: string; pairQr: string; secret: string; expiresAt: string };
}
const poll = async (p: { pairingId: string; secret: string }, secret = p.secret) =>
  ctx.app.inject({ method: 'GET', url: `/v1/present/${p.pairingId}`, headers: { 'x-present-secret': secret } });

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  const mk = async (email: string) =>
    (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', $2, $2) returning id`, [seed.tenantId, email])).rows[0]!.id;
  const tId = await mk('teach@iit.ac.in');
  await mk('other@iit.ac.in');
  await ctx.db.query('update courses set instructor_id = $1 where id = $2', [tId, seed.courseId]);
  teacher = new TestDevice(ctx);
  otherTeacher = new TestDevice(ctx);
  student = new TestDevice(ctx);
  await teacher.signIn('teach@iit.ac.in');
  await otherTeacher.signIn('other@iit.ac.in');
  await student.signIn('aarav@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('big-screen pairing', () => {
  it('shows the pairing code as a QR the Institute app can scan, and /tv is a short address', async () => {
    const p = await pair();
    const code = normalizePresentCode(p.code)!;
    expect(p.pairQr).toBe(await QRCode.toString(`${PRESENT_PAIR_PREFIX}${code}`, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#000000', light: '#ffffff' } }));
    expect(presentCodeFromScan(`attendly-tv:${code.toLowerCase()}`)).toBe(code);
    expect(presentCodeFromScan(code)).toBeNull(); // a bare code or a class QR is not a pairing QR
    expect(presentCodeFromScan('ATTENDLY-TV:not-a-code')).toBeNull();
    const tv = await ctx.app.inject({ method: 'GET', url: '/tv' });
    expect(tv.statusCode).toBe(302);
    expect(tv.headers.location).toBe('/present');
  });

  it('serves a locked-down page', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/present' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.body).toContain('/present.js');
    const js = await ctx.app.inject({ method: 'GET', url: '/present.js' });
    expect(() => new Function(js.body)).not.toThrow();
  });

  it('codes are 8 unambiguous characters and normalise from sloppy typing', async () => {
    const p = await pair();
    expect(p.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(normalizePresentCode(` ${p.code.toLowerCase().replace('-', ' ')} `)).toBe(p.code.replace('-', ''));
    expect(normalizePresentCode('ABCD-EFG0')).toBeNull(); // 0 is not in the alphabet
    expect(describeDevice(CHROME_WIN)).toBe('Chrome on Windows');
  });

  it('pairs, shows the live QR (never the secret), and ends with the class', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, rotationS: 7 });
    const p = await pair();
    expect((await poll(p)).json()).toMatchObject({ status: 'waiting' });

    const look = await teacher.call('POST', '/v1/staff/present/lookup', { code: p.code.toLowerCase() });
    expect(look.statusCode).toBe(200);
    expect(look.json()).toMatchObject({ id: p.pairingId, device: 'Chrome on Windows' });

    const approve = await teacher.call('POST', `/v1/staff/sessions/${s.id}/screens`, { code: p.code });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toHaveLength(1);

    const live = await poll(p);
    const body = live.json();
    expect(body.status).toBe('live');
    expect(body.qr.svg).toMatch(/^<svg/);
    expect(body.qr.seq).toBe(seqLabel(currentQrSeq(ctx.clock.now, 7)));
    expect(body.counts).toEqual({ marked: 0, enrolled: 2 });
    expect(live.body).not.toContain(toB64url(s.secret));

    // A code works once.
    expect((await teacher.call('POST', `/v1/staff/sessions/${s.id}/screens`, { code: p.code })).statusCode).toBe(404);

    await ctx.db.query(`update class_sessions set status = 'closed', ended_at = now() where id = $1`, [s.id]);
    expect((await poll(p)).json()).toMatchObject({ status: 'ended', class: { courseCode: 'CS-301' } });
  });

  it('refuses the wrong secret, other teachers, students, non-live classes and expired codes', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const p = await pair();
    expect((await poll(p, 'x'.repeat(43))).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/present/${p.pairingId}` })).statusCode).toBe(404);

    expect((await otherTeacher.call('POST', `/v1/staff/sessions/${s.id}/screens`, { code: p.code })).statusCode).toBe(404);
    expect((await student.call('POST', '/v1/staff/present/lookup', { code: p.code })).statusCode).toBe(403);

    const scheduled = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled' });
    expect((await teacher.call('POST', `/v1/staff/sessions/${scheduled.id}/screens`, { code: p.code })).json().error.code).toBe('CONFLICT');

    ctx.clock.now += 5 * 60_000 + 1;
    expect((await teacher.call('POST', '/v1/staff/present/lookup', { code: p.code })).statusCode).toBe(404);
    expect((await poll(p)).json()).toMatchObject({ status: 'expired' });
    expect((await teacher.call('POST', '/v1/staff/present/lookup', { code: 'nope' })).statusCode).toBe(400);
  });

  it('the teacher can disconnect a screen at any time', async () => {
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const p = await pair('Mozilla/5.0 (Linux; Android 11; SmartBoard) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
    await teacher.call('POST', `/v1/staff/sessions/${s.id}/screens`, { code: p.code });
    const list = await teacher.call('GET', `/v1/staff/sessions/${s.id}/screens`);
    expect(list.json()[0].device).toBe('Chrome on Android (TV / board / tablet)');
    expect((await otherTeacher.call('POST', `/v1/staff/sessions/${s.id}/screens/${p.pairingId}/disconnect`, {})).statusCode).toBe(404);
    const after = await teacher.call('POST', `/v1/staff/sessions/${s.id}/screens/${p.pairingId}/disconnect`, {});
    expect(after.json()).toEqual([]);
    expect((await poll(p)).json()).toEqual({ status: 'disconnected' });
    expect(await verifyAuditChain(ctx.db)).toMatchObject({ ok: true });
  });
});
