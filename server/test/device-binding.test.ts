import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindProofString, signB64 } from '@attendly/protocol';
import { bindChallenge } from '../src/lib/attestation';
import { at, createTestApp, liveToken, startLiveSession, TestDevice, type TestCtx } from './harness';
import { createAttestCA, type AttestCA } from './attest-helper';

let ctx: TestCtx;
let ca: AttestCA;
let tenantId: string;
let courseId: string;
let n = 0;

beforeAll(async () => {
  ctx = await createTestApp();
  ca = createAttestCA();
  ctx.deps.config.attestation.testRoots = [ca.rootPem];
  tenantId = (await ctx.db.query<{ id: string }>(`insert into tenants(slug, name, email_domains, term_start) values ('iit', 'IIT', '{iit.ac.in}', current_date - 30) returning id`)).rows[0]!.id;
  courseId = (await ctx.db.query<{ id: string }>(`insert into courses(tenant_id, code, title) values ($1, 'CS-301', 'Networks') returning id`, [tenantId])).rows[0]!.id;
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'admin', 'HOD', 'hod@iit.ac.in')`, [tenantId]);
});
afterAll(async () => {
  ca?.cleanup();
  await ctx?.close();
});
beforeEach(async () => {
  ctx.clock.now = Date.now();
  await ctx.db.query(`delete from tenant_flags`);
  await ctx.db.query(`delete from system_flags where key = 'hardware_checks_relaxed'`);
});

/** The institution turns on "Secure-hardware phones only". */
// Chip keys are never required by an institution; only the server operator can (REQUIRE_HARDWARE_KEYS).
const requireChips = async () => void (ctx.deps.config.attestation.requireHardware = true);

/** A new enrolled student and their phone. */
async function student(hardwareId = `hw-${++n}-${Math.random()}`) {
  const email = `s${++n}@iit.ac.in`;
  const id = (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', $2, $2) returning id`, [tenantId, email])).rows[0]!.id;
  await ctx.db.query('insert into enrollments(course_id, user_id) values ($1, $2)', [courseId, id]);
  return { id, email, phone: new TestDevice(ctx, { hardwareId }) };
}
async function bindResult(d: TestDevice, email: string) {
  ctx.clock.now += 31_000;
  const r = await d.requestOtp(email);
  const v = (await d.verifyOtp(r.json().challengeId, d.lastCode(email))).json();
  if (v.status !== 'bind_required') return { status: v.status, v };
  return { res: await d.bind(v.ticket), v };
}
const requireHardware = requireChips;
beforeEach(() => void (ctx.deps.config.attestation.requireHardware = false));
const mark = async (d: TestDevice, opts: { hw?: boolean } = {}) => {
  const s = await startLiveSession(ctx, { tenantId, courseId });
  return d.call('POST', '/v1/attendance/mark', { qr: liveToken(ctx, s), location: { ...at(5), accuracyM: 8, mocked: false, capturedAt: ctx.clock.now } }, opts);
};
const audits = async (action: string) => (await ctx.db.query(`select data from audit_log where action = $1`, [action])).rows;

describe('binding with the phone’s security chip', () => {
  it('a genuine phone binds with its chip key; every scan must then be signed by the chip', async () => {
    const s = await student();
    const bound = await s.phone.withChip(ca).signIn(s.email);
    expect(bound.device.hardware).toBe('tee');

    const unsigned = await mark(s.phone, { hw: false });
    expect(unsigned.statusCode).toBe(422);
    expect(unsigned.json().error.rejection.code).toBe('E-DEVICE');

    const ok = await mark(s.phone);
    expect(ok.statusCode).toBe(200);
    const rec = await ctx.db.query('select hw_signed from attendance_records where id = $1', [ok.json().record.id]);
    expect(rec.rows[0].hw_signed).toBe(true);
  });

  it('a copied software key alone can’t mark: the chip signature from another phone doesn’t verify', async () => {
    const s = await student();
    await s.phone.withChip(ca).signIn(s.email);
    const otherChip = ca.issue(bindChallenge('x'));
    s.phone.hwKey = otherChip; // the attacker's own genuine phone
    const res = await mark(s.phone);
    expect(res.json().error.rejection.code).toBe('E-DEVICE');
  });

  it('StrongBox is recorded as such', async () => {
    const s = await student();
    expect((await s.phone.withChip(ca, { level: 2 }).signIn(s.email)).device.hardware).toBe('strongbox');
  });

  it('a rooted / unlocked phone is refused where chips are required, recorded (not refused) elsewhere', async () => {
    const a = await student();
    const { res: soft } = await bindResult(a.phone.withChip(ca, { locked: false, boot: 2 }), a.email);
    expect(soft!.statusCode).toBe(200);
    expect(soft!.json().device.hardware).toBe('none');
    await new Promise((r) => setTimeout(r, 50));
    expect((await audits('device.attest_failed')).some((x) => x.data.code === 'boot')).toBe(true);
    await requireChips();
    const s = await student();
    const { res } = await bindResult(s.phone.withChip(ca, { locked: false, boot: 2 }), s.email);
    expect(res!.statusCode).toBe(403);
    expect(res!.json().error.message).toMatch(/rooted.*security check: boot/);
  });

  it('developers sign straight in without binding a phone (a new phone simply replaces the old one)', async () => {
    await requireChips();
    const email = `dev${++n}@iit.ac.in`;
    await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'developer', 'Dev', $2)`, [tenantId, email]);
    for (const hw of ['dev-a', 'dev-b']) {
      const phone = new TestDevice(ctx, { hardwareId: `${hw}-${n}` });
      ctx.clock.now += 31_000;
      const r = await phone.requestOtp(email);
      const v = (await phone.verifyOtp(r.json().challengeId, phone.lastCode(email))).json();
      expect(v.status).toBe('ok');
      phone.adopt(v.auth);
      expect((await phone.call('GET', '/v1/root/me')).statusCode).toBe(200);
    }
    const active = await ctx.db.query(`select 1 from devices d join users u on u.id = d.user_id where u.email = $1 and d.status = 'active'`, [email]);
    expect(active.rowCount).toBe(1);
  });

  it('a clone of the app is refused where chips are required', async () => {
    await requireChips();
    const s = await student();
    const { res } = await bindResult(s.phone.withChip(ca, { pkg: 'com.evil.attendly' }), s.email);
    expect(res!.statusCode).toBe(403);
    expect(res!.json().error.message).toMatch(/official Attendly app/);
  });

  it('without a chip (or on an old phone) binding still works while the institution allows it', async () => {
    const a = await student();
    expect((await a.phone.signIn(a.email)).device.hardware).toBe('none');
    const b = await student();
    expect((await b.phone.withChip(ca, { level: 0 }).signIn(b.email)).device.hardware).toBe('none');
    expect((await mark(b.phone)).statusCode).toBe(200);
  });

  it('“secure-hardware phones only”: no chip, a software key, or a replayed attestation is refused', async () => {
    await requireHardware();
    const a = await student();
    expect((await bindResult(a.phone, a.email)).res!.statusCode).toBe(403);
    const b = await student();
    expect((await bindResult(b.phone.withChip(ca, { level: 0 }), b.email)).res!.statusCode).toBe(403);
    // An attestation made for someone else's ticket.
    const c = await student();
    ctx.clock.now += 31_000;
    const r = await c.phone.requestOtp(c.email);
    const v = (await c.phone.verifyOtp(r.json().challengeId, c.phone.lastCode(c.email))).json();
    const proof = signB64(bindProofString({ ticket: v.ticket, publicKeyB64: c.phone.publicKeyB64, purpose: 'bind' }), c.phone.keys.secretKey);
    const replay = await ctx.app.inject({ method: 'POST', url: '/v1/devices/bind', payload: { ticket: v.ticket, proof, attestation: { chain: ca.issue(bindChallenge('old-ticket')).chain } } });
    expect(replay.statusCode).toBe(403);
    // A genuine phone is fine.
    const d = await student();
    expect((await d.phone.withChip(ca).signIn(d.email)).device.hardware).toBe('tee');
  });

  it('any phone works: the same phone re-binds after its app data is cleared, even without a chip key (recorded)', async () => {
    const was = ctx.deps.config.attestation.requireHardware;
    ctx.deps.config.attestation.requireHardware = false; // the default: no institution can require chips
    const s = await student('android-id-same-phone');
    await s.phone.withChip(ca).signIn(s.email);
    const cleared = new TestDevice(ctx, { hardwareId: 'android-id-same-phone' }); // same phone ID, no chip key sent
    const { res } = await bindResult(cleared, s.email);
    expect(res!.statusCode).toBe(200);
    const honest = new TestDevice(ctx, { hardwareId: 'android-id-same-phone' }).withChip(ca);
    const again = await bindResult(honest, s.email);
    expect(again.res!.statusCode).toBe(200);
    ctx.deps.config.attestation.requireHardware = was;
  });

  it('the emergency switch lets a wrongly refused phone model bind', async () => {
    await ctx.db.query(`insert into system_flags(key, enabled) values ('hardware_checks_relaxed', true)`);
    const s = await student();
    const { res } = await bindResult(s.phone.withChip(ca, { locked: false }), s.email);
    expect(res!.statusCode).toBe(200);
    expect(res!.json().device.hardware).toBe('none');
  });

  it('a new phone waiting for admin approval brings its verified chip key', async () => {
    const admin = new TestDevice(ctx, { hardwareId: 'admin-phone' });
    await admin.signIn('hod@iit.ac.in');
    const s = await student();
    await s.phone.withChip(ca).signIn(s.email);
    const next = new TestDevice(ctx, { hardwareId: 'new-phone-1' }).withChip(ca);
    const { status, v } = await bindResult(next, s.email);
    expect(status).toBe('device_mismatch');
    next.hwKey = ca.issue(bindChallenge(v.ticket));
    const proof = signB64(bindProofString({ ticket: v.ticket, publicKeyB64: next.publicKeyB64, purpose: 'rebind' }), next.keys.secretKey);
    const req = await ctx.app.inject({ method: 'POST', url: '/v1/devices/rebind-request', payload: { ticket: v.ticket, proof, reason: 'new phone', attestation: { chain: next.hwKey.chain } } });
    expect(req.statusCode).toBe(200);
    expect((await admin.call('POST', `/v1/staff/device-requests/${req.json().requestId}`, { decision: 'approve' })).statusCode).toBe(200);
    const d = await ctx.db.query(`select attest_level from devices where user_id = $1 and status = 'active'`, [s.id]);
    expect(d.rows[0].attest_level).toBe('tee');
  });
});

describe('phones bound before chip keys', () => {
  it('move their key into the chip once; it can never be swapped afterwards', async () => {
    const s = await student();
    await s.phone.signIn(s.email);
    const st = (await s.phone.call('GET', '/v1/devices/attest')).json();
    expect(st).toMatchObject({ hardware: 'none', required: false });
    expect(st.challenge).toBeTruthy();

    // An attestation for another challenge is refused and changes nothing.
    const wrong = await s.phone.call('POST', '/v1/devices/attest', { chain: ca.issue(bindChallenge('nope')).chain });
    expect(wrong.statusCode).toBe(403);

    const chip = ca.issue(Buffer.from(st.challenge, 'base64url'));
    const up = await s.phone.call('POST', '/v1/devices/attest', { chain: chip.chain });
    expect(up.statusCode).toBe(200);
    expect(up.json().hardware).toBe('tee');
    s.phone.hwKey = chip;
    expect((await s.phone.call('GET', '/v1/devices/attest')).json()).toMatchObject({ hardware: 'tee', challenge: null });
    expect((await mark(s.phone, { hw: false })).json().error.rejection.code).toBe('E-DEVICE');
    expect((await mark(s.phone)).statusCode).toBe(200);

    // A second attestation (e.g. from another genuine phone using a copied software key) is refused.
    await ctx.db.query(`insert into attest_challenges(device_id, challenge, expires_at) select id, $2, now() + interval '5 minutes' from devices where user_id = $1 and status = 'active'`, [
      s.id,
      Buffer.alloc(32, 1),
    ]);
    const swap = await s.phone.call('POST', '/v1/devices/attest', { chain: ca.issue(Buffer.alloc(32, 1)).chain });
    expect(swap.statusCode).toBe(409);
  });

  it('a phone Google proves rooted is remembered, and its scans are refused (institution requires chips)', async () => {
    const s = await student();
    await s.phone.signIn(s.email);
    await requireChips();
    const st = (await s.phone.call('GET', '/v1/devices/attest')).json();
    const res = await s.phone.call('POST', '/v1/devices/attest', { chain: ca.issue(Buffer.from(st.challenge, 'base64url'), { boot: 2, locked: false }).chain });
    expect(res.statusCode).toBe(403);
    expect((await mark(s.phone)).json().error.rejection.code).toBe('E-INTEGRITY');
    expect((await s.phone.call('GET', '/v1/devices/attest')).json().challenge).toBeNull();
  });

  it('when the institution requires chip keys, an un-upgraded phone is told to open the app online', async () => {
    const s = await student();
    await s.phone.signIn(s.email);
    await requireHardware();
    const res = await mark(s.phone);
    expect(res.json().error.rejection.code).toBe('E-DEVICE');
    expect(res.json().error.rejection.detail).toMatch(/Open Attendly while online/);
  });
});
