import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoticeDetail,
  NoticeReaders, NoticesResponse } from '@attendly/protocol';
import { createTestApp, seedBasic, TestDevice, type Seeded, type TestCtx } from './harness';

let ctx: TestCtx;
let seed: Seeded;
let admin: TestDevice;
let prof: TestDevice;
let other: TestDevice;
let aarav: TestDevice;
let priya: TestDevice;
let batchId: string;
let otherId: string;

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
  return JSON.parse(r.body);
};
const list = async (d: TestDevice, q = '') => NoticesResponse.parse(ok(await d.call('GET', `/v1/notices${q}`)));
const bell = async (d: TestDevice) => ok(await d.call('GET', '/v1/notifications')).items as { title: string; body: string; read: boolean; data?: Record<string, unknown> }[];
const post = (d: TestDevice, audience: unknown, extra: Record<string, unknown> = {}) =>
  d.call('POST', '/v1/notices', { title: 'Lab moved', body: '**Lab 3** is in *LH-2* today.\n- bring laptops', audience, ...extra });

beforeAll(async () => {
  ctx = await createTestApp();
  seed = await seedBasic(ctx.db);
  const mk = async (role: string, email: string) =>
    (await ctx.db.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, $2, $3, $4) returning id`, [seed.tenantId, role, email.split('@')[0], email])).rows[0]!.id;
  await mk('admin', 'hod@iit.ac.in');
  const profId = await mk('teacher', 'kumar@iit.ac.in');
  otherId = await mk('teacher', 'rao@iit.ac.in');
  await ctx.db.query('update courses set instructor_id = $1 where id = $2', [profId, seed.courseId]);
  batchId = (await ctx.db.query<{ id: string }>(`insert into batches(tenant_id, name) values ($1, 'CSE-A') returning id`, [seed.tenantId])).rows[0]!.id;
  await ctx.db.query('insert into batch_members(batch_id, user_id) values ($1, $2)', [batchId, seed.studentId]);
  admin = new TestDevice(ctx);
  prof = new TestDevice(ctx);
  other = new TestDevice(ctx);
  aarav = new TestDevice(ctx);
  priya = new TestDevice(ctx);
  await admin.signIn('hod@iit.ac.in');
  await prof.signIn('kumar@iit.ac.in');
  await other.signIn('rao@iit.ac.in');
  await aarav.signIn('aarav@iit.ac.in');
  await priya.signIn('priya@iit.ac.in');
});
afterAll(async () => ctx?.close());

describe('notice centre', () => {
  let batchNotice: string;

  it('a professor can’t broadcast institution-wide, but can post to a batch — only its members get it', async () => {
    const r = await post(prof, { kind: 'everyone' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toContain('Notices to everyone');
    expect(ok(await prof.call('POST', '/v1/notices/audience', { kind: 'batches', batchIds: [batchId] }))).toEqual({ recipients: 1, label: 'CSE-A' });
    const n = NoticeDetail.parse(ok(await post(prof, { kind: 'batches', batchIds: [batchId] }, { category: 'academic' })));
    batchNotice = n.id;
    expect(n).toMatchObject({ audienceLabel: 'CSE-A', canEdit: true, stats: { recipients: 1, seen: 0 }, author: { role: 'Professor' } });
    expect((await list(aarav)).items.map((x) => x.id)).toContain(n.id);
    expect((await list(priya)).items.map((x) => x.id)).not.toContain(n.id);
    const b = await bell(aarav);
    expect(b[0]).toMatchObject({ title: '📚 Lab moved', body: 'kumar: Lab 3 is in LH-2 today. · • bring laptops' });
  });

  it('subjects: only the ones you teach', async () => {
    ok(await post(prof, { kind: 'courses', courseIds: [seed.courseId] }));
    expect((await post(prof, { kind: 'courses', courseIds: [seed.otherCourseId] })).statusCode).toBe(403);
    expect((await post(other, { kind: 'courses', courseIds: [seed.courseId] })).statusCode).toBe(403);
  });

  it('opening a notice marks it read (and its notification); the author sees “seen by”', async () => {
    expect((await list(aarav, '?filter=unread')).items.some((x) => x.id === batchNotice)).toBe(true);
    const d = NoticeDetail.parse(ok(await aarav.call('GET', `/v1/notices/${batchNotice}`)));
    expect(d).toMatchObject({ read: true, canEdit: false, stats: null });
    expect(d.body).toContain('**Lab 3**');
    expect((await list(aarav, '?filter=unread')).items.some((x) => x.id === batchNotice)).toBe(false);
    expect((await bell(aarav)).find((x) => x.title === '📚 Lab moved')?.read).toBe(true);
    expect(NoticeDetail.parse(ok(await prof.call('GET', `/v1/notices/${batchNotice}`))).stats).toEqual({ recipients: 1, seen: 1 });
    // …and exactly who: names, with when they opened it.
    const readers = NoticeReaders.parse(ok(await prof.call('GET', `/v1/notices/${batchNotice}/readers`)));
    expect(readers.seen.map((r) => r.name)).toEqual(['aarav']);
    expect(readers.seen[0]!.readAt).toBeTruthy();
    expect(readers.notSeen).toEqual([]);
    expect((await aarav.call('GET', `/v1/notices/${batchNotice}/readers`)).statusCode).toBe(403);
    // Not in the batch: can't open it.
    expect((await priya.call('GET', `/v1/notices/${batchNotice}`)).statusCode).toBe(404);
  });

  it('emoji reactions: tap to add, tap again to remove; only the fixed set', async () => {
    ok(await aarav.call('POST', `/v1/notices/${batchNotice}/react`, { emoji: '👍' }));
    const r = ok(await aarav.call('POST', `/v1/notices/${batchNotice}/react`, { emoji: '🎉' }));
    expect(r).toEqual([
      { emoji: '👍', count: 1, mine: true },
      { emoji: '🎉', count: 1, mine: true },
    ]);
    expect(ok(await aarav.call('POST', `/v1/notices/${batchNotice}/react`, { emoji: '👍' }))).toEqual([{ emoji: '🎉', count: 1, mine: true }]);
    expect((await aarav.call('POST', `/v1/notices/${batchNotice}/react`, { emoji: '💩' })).statusCode).toBe(400);
    expect((await priya.call('POST', `/v1/notices/${batchNotice}/react`, { emoji: '👍' })).statusCode).toBe(404);
  });

  it('admins broadcast to everyone (pinned, important); the other institution sees nothing', async () => {
    const n = NoticeDetail.parse(ok(await post(admin, { kind: 'everyone' }, { title: 'Holiday on Friday', category: 'holiday', pinned: true, important: true })));
    expect(n.stats!.recipients).toBe(4); // 2 students + 2 professors (not the author, not other institutions)
    for (const d of [aarav, priya, prof, other]) expect((await list(d)).pinned.map((x) => x.id)).toContain(n.id);
    expect((await bell(priya))[0]!.title).toBe('⚠️ Important · Holiday on Friday');
    const outsider = new TestDevice(ctx);
    await outsider.signIn('zed@other.edu');
    expect((await list(outsider)).pinned).toHaveLength(0);
    // Students-only and faculty-only
    const staffOnly = NoticeDetail.parse(ok(await post(admin, { kind: 'staff' }, { title: 'Faculty meeting' })));
    expect((await list(prof)).items.map((x) => x.id)).toContain(staffOnly.id);
    expect((await list(aarav)).items.map((x) => x.id)).not.toContain(staffOnly.id);
  });

  it('an admin can give a professor “Notices to everyone”', async () => {
    ok(await admin.call('POST', `/v1/staff/people/${otherId}/access`, { role: 'teacher', permissions: ['broadcast'] }));
    ok(await post(other, { kind: 'students' }, { title: 'Sports day' }));
  });

  it('edit and delete: author or admin only; deleted notices disappear with their notification', async () => {
    expect((await other.call('POST', `/v1/notices/${batchNotice}`, { title: 'Hacked' })).statusCode).toBe(404); // can't even see it
    const e = NoticeDetail.parse(ok(await admin.call('POST', `/v1/notices/${batchNotice}`, { title: 'Lab 3 moved to LH-2' })));
    expect(e.editedAt).not.toBeNull();
    expect((await aarav.call('POST', `/v1/notices/${batchNotice}/delete`, {})).statusCode).toBe(403);
    const before = (await bell(aarav)).filter((x) => x.title.includes('Lab moved')).length;
    ok(await prof.call('POST', `/v1/notices/${batchNotice}/delete`, {}));
    expect((await aarav.call('GET', `/v1/notices/${batchNotice}`)).statusCode).toBe(404);
    expect((await bell(aarav)).filter((x) => x.title.includes('Lab moved')).length).toBe(before - 1);
  });

  it('read all', async () => {
    expect((await list(priya)).unread).toBeGreaterThan(0);
    ok(await priya.call('POST', '/v1/notices/read-all', {}));
    expect((await list(priya)).unread).toBe(0);
  });
});
