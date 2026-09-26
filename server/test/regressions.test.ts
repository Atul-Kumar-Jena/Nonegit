/** Regression tests for issues found in code review. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx, liveToken } from './harness';
import { verifyAuditChain } from '../src/lib/audit';

let ctx: TestCtx;
let seed: Seeded;

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
});
afterAll(async () => ctx?.close());

async function newStudent(email: string, enrol = true) {
  const u = await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'student', $2, $2) returning id`, [seed.tenantId, email]);
  if (enrol) await ctx.db.query('insert into enrollments(course_id, user_id) values ($1, $2)', [seed.courseId, u.rows[0]!.id]);
  return u.rows[0]!.id;
}

describe('review regressions', () => {
  it('a phone that was unbound by an admin can be bound again', async () => {
    const id = await newStudent('rebind@iit.ac.in');
    const phone = new TestDevice(ctx);
    await phone.signIn('rebind@iit.ac.in');
    await ctx.db.query(`update devices set status = 'revoked', revoked_at = now() where user_id = $1`, [id]);
    expect((await phone.call('GET', '/v1/me/profile')).json().error.code).toBe('DEVICE_REVOKED');
    ctx.clock.now += 31_000;
    await phone.signIn('rebind@iit.ac.in'); // bind_required → bind succeeds with the same key
    expect((await phone.call('GET', '/v1/me/profile')).statusCode).toBe(200);
    const { rows } = await ctx.db.query(`select status from devices where user_id = $1 order by created_at`, [id]);
    expect(rows.map((r: { status: string }) => r.status)).toEqual(['revoked', 'active']);
    ctx.clock.now = Date.now();
  });

  it('a 100% attendance rule does not break the subjects response', async () => {
    await newStudent('strict@iit.ac.in');
    const phone = new TestDevice(ctx);
    await phone.signIn('strict@iit.ac.in');
    const s1 = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    await ctx.db.query(`update class_sessions set status = 'closed' where id = $1`, [s1.id]); // missed one
    await ctx.db.query(`update tenants set min_attendance = 100 where id = $1`, [seed.tenantId]);
    try {
      const r = await phone.call('GET', '/v1/me/subjects');
      expect(r.statusCode).toBe(200);
      const cs = r.json().subjects.find((s: { code: string }) => s.code === 'CS-301');
      expect(cs.standing).toBe('at-risk');
      expect(cs.needToReach).toBe(10_000);
    } finally {
      await ctx.db.query(`update tenants set min_attendance = 75 where id = $1`, [seed.tenantId]);
    }
  });

  it('refusals caused by the institution (paused / not live) never lock a student out', async () => {
    await newStudent('patient@iit.ac.in');
    const phone = new TestDevice(ctx);
    await phone.signIn('patient@iit.ac.in');
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId });
    const mark = () => phone.call('POST', '/v1/attendance/mark', { qr: liveToken(ctx, s), location: { ...at(5), accuracyM: 8, mocked: false, capturedAt: ctx.clock.now } });
    await ctx.db.query(`update system_flags set enabled = true where key = 'scans_paused'`);
    try {
      for (let i = 0; i < 45; i++) expect((await mark()).json().error.rejection.code).toBe('E-PAUSED');
    } finally {
      await ctx.db.query(`update system_flags set enabled = false where key = 'scans_paused'`);
    }
    expect((await mark()).statusCode).toBe(200);
  });

  it('keeps one audit chain per tenant and still verifies', async () => {
    const other = new TestDevice(ctx);
    await other.signIn('zed@other.edu');
    const r = await verifyAuditChain(ctx.db);
    expect(r.ok).toBe(true);
    expect(r.chains).toBeGreaterThanOrEqual(2);
    const { rows } = await ctx.db.query(`select count(distinct coalesce(tenant_id::text, 'global'))::int as n from audit_log`);
    expect(r.chains).toBe(rows[0].n);
  });
});

describe('config from a hosting dashboard', () => {
  it('treats blank optional variables as unset and prefers a pasted CA over no-verify', async () => {
    const { loadConfig } = await import('../src/config');
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@db.example.com:5432/postgres',
      SERVER_SIGNING_KEY: Buffer.alloc(32, 1).toString('base64'),
      TOKEN_PEPPER: Buffer.alloc(32, 2).toString('base64'),
      OTP_DELIVERY: 'console',
      DATABASE_SSL: 'no-verify',
      BOOTSTRAP_DEMO_STUDENT_EMAIL: '',
      BOOTSTRAP_DEMO_TEACHER_EMAIL: '  ',
      SMTP_URL: '',
      DATABASE_SSL_CA: '',
    };
    const c = loadConfig(base);
    expect(c.databaseSsl).toEqual({ rejectUnauthorized: false });
    const withCa = loadConfig({ ...base, DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----' });
    expect(withCa.databaseSsl).toMatchObject({ rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' });
  });
});
