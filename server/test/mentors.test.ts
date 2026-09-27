import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BatchDetail, StaffMe, bindProofString, signB64 } from '@attendly/protocol';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let admin: TestDevice;
let mentor: TestDevice;
let other: TestDevice;
let mentorId: string;
let batchId: string;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const bell = async (userId: string, kind: string) =>
  (await ctx.db.query<{ title: string; data: Record<string, unknown> }>('select title, data from notifications where user_id = $1 and kind = $2 order by created_at', [userId, kind])).rows;

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  const mk = async (role: string, email: string, name: string) =>
    (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, $2, $3, $4) returning id`, [seed.tenantId, role, name, email])).rows[0]!.id;
  await mk('admin', 'hod@iit.ac.in', 'HOD');
  mentorId = await mk('teacher', 'mentor@iit.ac.in', 'Dr. Mentor');
  await mk('teacher', 'other@iit.ac.in', 'Dr. Other');
  admin = new TestDevice(ctx, { hardwareId: 'admin-phone' });
  mentor = new TestDevice(ctx, { hardwareId: 'mentor-phone' });
  other = new TestDevice(ctx, { hardwareId: 'other-phone' });
  await admin.signIn('hod@iit.ac.in');
  await mentor.signIn('mentor@iit.ac.in');
  await other.signIn('other@iit.ac.in');
  batchId = ok(await admin.call('POST', '/v1/staff/batches', { name: 'CSE-A', semester: 5 })).id;
  ok(await admin.call('POST', `/v1/staff/batches/${batchId}`, { addMembers: [seed.studentId] }));
});
afterAll(async () => ctx?.close());

describe('batch mentors', () => {
  it('an admin picks a mentor; the mentor is told and sees it on their profile', async () => {
    const d = BatchDetail.parse(ok(await admin.call('POST', `/v1/staff/batches/${batchId}`, { mentorId })));
    expect(d.mentor).toEqual({ id: mentorId, name: 'Dr. Mentor' });
    expect((await bell(mentorId, 'mentor')).map((n) => n.title)).toEqual(['You’re now mentor of CSE-A']);
    expect(StaffMe.parse(ok(await mentor.call('GET', '/v1/staff/me'))).mentorOf).toEqual([{ id: batchId, name: 'CSE-A' }]);
    // Only an admin / the creator may change it.
    expect((await other.call('POST', `/v1/staff/batches/${batchId}`, { mentorId: null })).statusCode).toBe(403);
    // A mentor must be staff.
    expect((await admin.call('POST', `/v1/staff/batches/${batchId}`, { mentorId: seed.student2Id })).statusCode).toBe(400);
  });

  it('a professor who creates a batch mentors it', async () => {
    const b = ok(await other.call('POST', '/v1/staff/batches', { name: 'ECE-B' }));
    expect(b.mentor.name).toBe('Dr. Other');
  });

  it('a student’s unbind request goes to their mentor, who decides it; the student hears back', async () => {
    const student = new TestDevice(ctx, { hardwareId: 'aarav-phone' });
    await student.signIn('aarav@iit.ac.in');
    const req = ok(await student.call('POST', '/v1/me/device-reset', { reason: 'Phone broke, getting a new one' }));
    const alerts = await bell(mentorId, 'device_request');
    expect(alerts.at(-1)?.title).toMatch(/aarav.*asks to unbind/);
    expect(alerts.at(-1)?.data.requestId).toBe(req.requestId);
    // Only the mentor (and admins) see / decide it — not other professors.
    expect((await other.call('GET', '/v1/staff/device-requests')).statusCode).toBe(403);
    const list = ok(await mentor.call('GET', '/v1/staff/device-requests'));
    expect(list.map((r: { id: string }) => r.id)).toEqual([req.requestId]);
    ok(await mentor.call('POST', `/v1/staff/device-requests/${req.requestId}`, { decision: 'approve' }));
    expect((await bell(seed.studentId, 'device')).map((n) => n.title)).toEqual(['✅ Phone unbound']);
    expect((await student.call('GET', '/v1/me/dashboard')).statusCode).toBe(401);
  });

  it('a switch to a new phone goes to the mentor too; declining keeps the old phone', async () => {
    const oldPhone = new TestDevice(ctx, { hardwareId: 'aarav-phone-2' });
    ctx.clock.now += 31_000;
    await oldPhone.signIn('aarav@iit.ac.in');
    const newPhone = new TestDevice(ctx, { hardwareId: 'aarav-phone-3' });
    ctx.clock.now += 31_000;
    const r = await newPhone.requestOtp('aarav@iit.ac.in');
    const v = (await newPhone.verifyOtp(r.json().challengeId, newPhone.lastCode('aarav@iit.ac.in'))).json();
    expect(v.status).toBe('device_mismatch');
    const proof = signB64(bindProofString({ ticket: v.ticket, publicKeyB64: newPhone.publicKeyB64, purpose: 'rebind' }), newPhone.keys.secretKey);
    const req = ok(await ctx.app.inject({ method: 'POST', url: '/v1/devices/rebind-request', payload: { ticket: v.ticket, proof, reason: 'new phone' } }));
    expect((await bell(mentorId, 'device_request')).at(-1)?.title).toMatch(/wants to switch phones/);
    ok(await mentor.call('POST', `/v1/staff/device-requests/${req.requestId}`, { decision: 'deny' }));
    expect((await bell(seed.studentId, 'device')).at(-1)?.title).toBe('❌ Phone switch declined');
    expect((await oldPhone.call('GET', '/v1/me/dashboard')).statusCode).toBe(200);
  });

  it('students without a mentored batch: requests go to the admins', async () => {
    const priya = new TestDevice(ctx, { hardwareId: 'priya-phone' });
    await priya.signIn('priya@iit.ac.in');
    ok(await priya.call('POST', '/v1/me/device-reset', { reason: 'Lost my phone yesterday' }));
    const adminId = (await ctx.db.query<{ id: string }>(`select id from users where email = 'hod@iit.ac.in'`)).rows[0]!.id;
    expect((await bell(adminId, 'device_request')).at(-1)?.title).toMatch(/priya/);
    expect((await bell(mentorId, 'device_request')).some((n) => /priya/.test(n.title))).toBe(false);
  });
});
