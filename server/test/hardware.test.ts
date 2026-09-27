import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindProofString, signB64 } from '@attendly/protocol';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'Dr. Kumar', 'kumar@iit.ac.in')`, [seed.tenantId]);
  await ctx.db.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'admin', 'HOD', 'hod@iit.ac.in')`, [seed.tenantId]);
});
afterAll(async () => ctx?.close());

/** The same physical phone after its app data was cleared: new key, same hardware ID. */
const phone = (hardwareId: string) => new TestDevice(ctx, { hardwareId });
async function verify(d: TestDevice, email: string) {
  ctx.clock.now += 31_000; // past the code-resend wait
  const r = await d.requestOtp(email);
  return (await d.verifyOtp(r.json().challengeId, d.lastCode(email))).json();
}

describe('one physical phone, one student', () => {
  it('clearing the app’s data re-binds the same student on the same phone, and the old key stops working', async () => {
    const first = phone('android-id-aaaa1111');
    await first.signIn('aarav@iit.ac.in');
    expect((await first.call('GET', '/v1/me/dashboard')).statusCode).toBe(200);

    const cleared = phone('android-id-aaaa1111');
    const v = await verify(cleared, 'aarav@iit.ac.in');
    expect(v.status).toBe('bind_required'); // no admin approval needed: it's their phone
    expect((await cleared.bind(v.ticket)).statusCode).toBe(200);
    expect((await cleared.call('GET', '/v1/me/dashboard')).statusCode).toBe(200);
    expect((await first.call('GET', '/v1/me/dashboard')).statusCode).toBe(401);
    const audit = await ctx.db.query(`select 1 from audit_log where action = 'device.rekey_same_phone'`);
    expect(audit.rowCount).toBe(1);
  });

  it('a second student can’t register the same phone, even after clearing data', async () => {
    const d = phone('android-id-aaaa1111');
    const v = await verify(d, 'priya@iit.ac.in');
    expect(v.status).toBe('bind_required');
    const b = await d.bind(v.ticket);
    expect(b.statusCode).toBe(409);
    expect(b.json().error.message).toContain('One phone, one student');
  });

  it('a different phone still needs the admin', async () => {
    const other = phone('android-id-bbbb2222');
    expect((await verify(other, 'aarav@iit.ac.in')).status).toBe('device_mismatch');
  });

  it('staff can’t share a phone with a student either: one phone, one account', async () => {
    const d = phone('android-id-aaaa1111');
    await expect(d.signIn('kumar@iit.ac.in')).rejects.toThrow(/One phone, one account/);
  });

  it('an admin can’t approve moving a student onto another student’s phone', async () => {
    const admin = phone('android-id-admin0001');
    await admin.signIn('hod@iit.ac.in');
    const priya = phone('android-id-cccc3333');
    await priya.signIn('priya@iit.ac.in');
    // Priya asks to move to Aarav's phone.
    const onAaravs = phone('android-id-aaaa1111');
    const v = await verify(onAaravs, 'priya@iit.ac.in');
    expect(v.status).toBe('device_mismatch');
    const proof = signB64(bindProofString({ ticket: v.ticket, publicKeyB64: onAaravs.publicKeyB64, purpose: 'rebind' }), onAaravs.keys.secretKey);
    const req = await ctx.app.inject({ method: 'POST', url: '/v1/devices/rebind-request', payload: { ticket: v.ticket, proof, reason: 'new phone' } });
    expect(req.statusCode).toBe(200);
    const approve = await admin.call('POST', `/v1/staff/device-requests/${req.json().requestId}`, { decision: 'approve' });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.message).toContain('One phone, one student');
  });

  it('phones bound before this change pick up their hardware ID at the next sign-in', async () => {
    const d = phone('android-id-dddd4444');
    await d.signIn('zed@other.edu');
    await ctx.db.query(`update devices set hw_hash = null where user_id = $1`, [seed.outsiderId]);
    ctx.clock.now += 31_000;
    const r = await d.requestOtp('zed@other.edu');
    expect((await d.verifyOtp(r.json().challengeId, d.lastCode('zed@other.edu'))).json().status).toBe('ok');
    const row = await ctx.db.query<{ hw_hash: Buffer | null }>(`select hw_hash from devices where user_id = $1 and status = 'active'`, [seed.outsiderId]);
    expect(row.rows[0]!.hw_hash).not.toBeNull();
  });
});
