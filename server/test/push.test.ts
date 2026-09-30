import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUSH_APPS, pushAppOf, pushConfig, startPushDispatcher, type PushSender } from '../src/lib/push';
import { insertNotifications } from '../src/lib/notify';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const sa = (project: string) => JSON.stringify({ project_id: project, client_email: `push@${project}.iam.gserviceaccount.com`, private_key: key });

describe('Firebase per app', () => {
  it('each app uses its own service account, or the shared one', () => {
    expect(pushConfig({})).toEqual({ student: null, institute: null });
    const shared = pushConfig({ FCM_SERVICE_ACCOUNT: sa('both') });
    expect(shared.student?.project_id).toBe('both');
    expect(shared.institute?.project_id).toBe('both');
    const split = pushConfig({ FCM_SERVICE_ACCOUNT_STUDENT: sa('stud'), FCM_SERVICE_ACCOUNT_INSTITUTE: sa('inst'), FCM_SERVICE_ACCOUNT: sa('both') });
    expect([split.student?.project_id, split.institute?.project_id]).toEqual(['stud', 'inst']);
    // Base64 of the file works too (some dashboards mangle multi-line values).
    expect(pushConfig({ FCM_SERVICE_ACCOUNT_STUDENT: Buffer.from(sa('b64')).toString('base64') }).student?.project_id).toBe('b64');
    expect(pushConfig({ FCM_SERVICE_ACCOUNT_STUDENT: 'not json' }).student).toBeNull();
    expect(PUSH_APPS.map((a) => a)).toEqual(['student', 'institute']);
    expect([pushAppOf('student'), pushAppOf('teacher'), pushAppOf('admin'), pushAppOf('developer')]).toEqual(['student', 'institute', 'institute', null]);
  });

  describe('dispatcher', () => {
    let ctx: TestCtx;
    let seed: Seeded;
    let teacherId: string;
    beforeAll(async () => {
      ctx = await createTestApp();
      seed = await seedBasic(ctx.db);
      teacherId = (
        await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'T', 'teach@iit.ac.in') returning id`, [seed.tenantId])
      ).rows[0]!.id;
      const student = new TestDevice(ctx);
      const teacher = new TestDevice(ctx);
      await student.signIn('aarav@iit.ac.in');
      await teacher.signIn('teach@iit.ac.in');
      expect((await student.call('POST', '/v1/me/push-token', { token: 'student-phone-token-1', platform: 'android' })).statusCode).toBe(200);
      expect((await teacher.call('POST', '/v1/me/push-token', { token: 'teacher-phone-token-1', platform: 'android' })).statusCode).toBe(200);
    });
    afterAll(async () => ctx?.close());

    it('sends a student’s notifications through the Student project and staff ones through the Institute project', async () => {
      const got: { app: string; to: string; title: string }[] = [];
      const fake = (app: string): PushSender => ({ send: async (to, n) => (got.push({ app, to, title: n.title }), 'ok') });
      await insertNotifications(ctx.db, seed.tenantId, [
        { userId: seed.studentId, kind: 'notice', title: 'For the student', body: 'b', data: {} },
        { userId: teacherId, kind: 'notice', title: 'For the teacher', body: 'b', data: {} },
      ]);
      const stop = startPushDispatcher(ctx.db, { student: fake('student'), institute: fake('institute') }, () => undefined);
      for (let i = 0; i < 40 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 150));
      stop();
      expect(got.sort((a, b) => a.app.localeCompare(b.app))).toEqual([
        { app: 'institute', to: 'teacher-phone-token-1', title: 'For the teacher' },
        { app: 'student', to: 'student-phone-token-1', title: 'For the student' },
      ]);
      const ok = await ctx.db.query<{ n: number }>('select count(*)::int as n from notifications where push_ok');
      expect(ok.rows[0]!.n).toBe(2);
    });

    it('a new notification is pushed at once, not at the next 2-second poll', async () => {
      const got: number[] = [];
      const stop = startPushDispatcher(ctx.db, { student: { send: async () => (got.push(Date.now()), 'ok') }, institute: { send: async () => 'ok' } }, () => undefined);
      await new Promise((r) => setTimeout(r, 300)); // let the first poll pass
      const t0 = Date.now();
      await insertNotifications(ctx.db, seed.tenantId, [{ userId: seed.studentId, kind: 'notice', title: 'Now', body: 'b', data: {} }]);
      for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
      stop();
      expect(got.length).toBe(1);
      expect(got[0]! - t0).toBeLessThan(1000);
    });

    it('an app without Firebase is skipped (its phones check for news themselves)', async () => {
      const got: string[] = [];
      await insertNotifications(ctx.db, seed.tenantId, [
        { userId: seed.studentId, kind: 'notice', title: 'S2', body: 'b', data: {} },
        { userId: teacherId, kind: 'notice', title: 'T2', body: 'b', data: {} },
      ]);
      const stop = startPushDispatcher(ctx.db, { institute: { send: async (_to, n) => (got.push(n.title), 'ok') } }, () => undefined);
      for (let i = 0; i < 40 && got.length < 1; i++) await new Promise((r) => setTimeout(r, 150));
      await new Promise((r) => setTimeout(r, 2500));
      stop();
      expect(got).toEqual(['T2']);
      const s2 = await ctx.db.query<{ push_ok: boolean }>(`select push_ok from notifications where title = 'S2'`);
      expect(s2.rows[0]!.push_ok).toBe(false);
    });
  });
});
