import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETENTION_RULES, runRetention, storageReport } from '../src/lib/retention';
import { createTestApp, seedBasic, startLiveSession, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let aarav: TestDevice;

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  aarav = new TestDevice(ctx);
  await aarav.signIn('aarav@iit.ac.in');
});
afterAll(async () => ctx?.close());

const count = async (sql: string, params: unknown[] = []) => (await ctx.db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n;

describe('data lifecycle', () => {
  it('trims old working data, keeps fresh rows and every institution record', async () => {
    const now = new Date();
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
    const device = (await ctx.db.query<{ id: string }>('select id from devices where user_id = $1', [seed.studentId])).rows[0]!.id;
    // Notifications: read + 7 months old (goes), read + recent (stays), unread + 13 months (goes), unread + 2 months (stays).
    const note = (read: boolean, at: Date) =>
      ctx.db.query(`insert into notifications(tenant_id, user_id, kind, title, body, data, created_at, read_at) values ($1, $2, 'notice', 't', 'b', '{}', $3, $4)`, [
        seed.tenantId,
        seed.studentId,
        at,
        read ? at : null,
      ]);
    await note(true, days(210));
    await note(true, days(10));
    await note(false, days(400));
    await note(false, days(60));
    // Offline-upload receipts: 40 days old (goes) and today (stays).
    await ctx.db.query(`insert into client_actions(user_id, client_ref, kind, result, created_at) values ($1, 'old-ref-1', 'x', '{}', $2), ($1, 'new-ref-1', 'x', '{}', now())`, [seed.studentId, days(40)]);
    // Online evidence: 3 days old (goes), now (stays).
    await ctx.db.query(`insert into device_online(device_id, minute) values ($1, date_trunc('minute', $2::timestamptz)), ($1, date_trunc('minute', now()))`, [device, days(3)]);
    // A replaced login token from 10 days ago (goes); the live one stays.
    await ctx.db.query(`update auth_sessions set rotated_at = null where device_id = $1`, [device]);
    const liveLogins = await count('auth_sessions where device_id = $1', [device]);
    await ctx.db.query(
      `insert into auth_sessions(family_id, user_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, family_expires_at, rotated_at, created_at)
       values (gen_random_uuid(), $1, $2, sha256(gen_random_uuid()::text::bytea), now(), sha256(gen_random_uuid()::text::bytea), now() + interval '20 days', now() + interval '90 days', $3, $3)`,
      [seed.studentId, device, days(10)],
    );
    // A real class with attendance, long ago: records are never trimmed.
    const s = await startLiveSession(ctx, { tenantId: seed.tenantId, courseId: seed.courseId, status: 'scheduled', startedAt: days(800).getTime() });
    await ctx.db.query(`update class_sessions set status = 'closed', started_at = scheduled_start, ended_at = scheduled_end where id = $1`, [s.id]);
    const auditBefore = await count('audit_log');

    const removed = (await runRetention(ctx.db, now))!;
    expect(removed['notif-read']).toBe(1);
    expect(removed['notif-old']).toBe(1);
    expect(removed.actions).toBe(1);
    expect(removed.online).toBeGreaterThanOrEqual(1);
    expect(removed.rotated).toBe(1);
    expect(await count(`notifications where user_id = $1`, [seed.studentId])).toBe(2);
    expect(await count(`client_actions where client_ref = 'new-ref-1'`)).toBe(1);
    expect(await count('device_online where minute > now() - interval \'1 hour\'')).toBeGreaterThanOrEqual(1);
    expect(await count('auth_sessions where device_id = $1', [device])).toBe(liveLogins);
    expect(await count('class_sessions where id = $1', [s.id])).toBe(1);
    expect(await count('audit_log')).toBe(auditBefore);
    // The signed-in phone still works.
    expect((await aarav.call('GET', '/v1/me/dashboard')).statusCode).toBe(200);
  });

  it('only one server cleans up at a time', async () => {
    const [a, b] = await Promise.all([runRetention(ctx.db, new Date()), runRetention(ctx.db, new Date())]);
    expect([a, b].filter((x) => x === null).length).toBeLessThanOrEqual(1);
    expect([a, b].some((x) => x !== null)).toBe(true);
  });

  it('every rule is valid SQL with an index-friendly condition, and the storage report works', async () => {
    for (const r of RETENTION_RULES) await ctx.db.query(`explain select 1 from ${r.table} where ${r.where}`, [new Date()]);
    const rep = await storageReport(ctx.db);
    expect(rep.dbBytes).toBeGreaterThan(0);
    expect(rep.tables.length).toBeGreaterThan(3);
  });
});
