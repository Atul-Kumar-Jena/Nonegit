/**
 * Notice centre. Who may post:
 *   • everyone / all students / all faculty — admins, and professors with "Notices to everyone"
 *   • batches — any professor or admin (any batch of the institution)
 *   • subjects — admins / coordinators any subject; professors the subjects they teach
 * Who sees a notice: exactly its audience, plus its author and the institution's admins.
 * Every recipient gets a notification at once (bell + phone push).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NOTICE_CATEGORIES,
  NoticeBody,
  NoticeUpdateBody,
  NoticesQuery,
  ReactBody,
  NoticeAudience,
  richToPlain,
  type AudienceCountResponse,
  type NoticeDetail,
  type NoticeSummary,
  type NoticesResponse,
  type NoticeReaders,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { can, isAdmin, seesAll } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { requireDevice, type AuthContext } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { insertNotifications } from '../lib/notify';

const EVERYONE = ['student', 'teacher', 'admin'] as const;
const IdParam = z.object({ id: z.uuid() });
const PAGE = 30;

interface NoticeRow {
  id: string;
  title: string;
  body: string;
  category: NoticeSummary['category'];
  audience: 'everyone' | 'students' | 'staff' | 'admins' | 'batches' | 'courses';
  platform: boolean;
  author_label: string | null;
  batch_ids: string[];
  course_ids: string[];
  audience_label: string;
  pinned: boolean;
  important: boolean;
  recipients: number;
  created_at: Date;
  edited_at: Date | null;
  author_id: string | null;
  author_name: string | null;
  author_role: string | null;
  read: boolean;
  reactions: { emoji: NoticeSummary['reactions'][number]['emoji']; count: number; mine: boolean }[];
}

/** SQL: notices the caller may see. $1 tenant, $2 user, $3 role, $4 admin. */
const VISIBLE = `n.tenant_id = $1 and n.deleted_at is null and (
    $4::boolean or n.author_id = $2
    or n.audience = 'everyone'
    or (n.audience = 'students' and $3 = 'student')
    or (n.audience = 'staff' and $3 in ('teacher', 'admin'))
    or (n.audience = 'admins' and $3 = 'admin')
    or (n.audience = 'batches' and exists (select 1 from batch_members m where m.user_id = $2 and m.batch_id = any(n.batch_ids)))
    or (n.audience = 'courses' and exists (select 1 from enrollments e where e.user_id = $2 and e.course_id = any(n.course_ids)))
    or (n.audience = 'courses' and exists (select 1 from courses c where c.id = any(n.course_ids) and c.instructor_id = $2)))`;

const SELECT = `
  select n.*, a.full_name as author_name, a.role as author_role,
         (n.author_id = $2 or exists (select 1 from notice_reads r where r.notice_id = n.id and r.user_id = $2)) as read,
         coalesce((select json_agg(json_build_object('emoji', x.emoji, 'count', x.c, 'mine', x.mine) order by x.first)
                     from (select emoji, count(*)::int as c, bool_or(user_id = $2) as mine, min(created_at) as first
                             from notice_reactions where notice_id = n.id group by emoji) x), '[]') as reactions
    from notices n left join users a on a.id = n.author_id`;

const params = (auth: AuthContext) => [auth.tenantId, auth.userId, auth.role, isAdmin(auth)];
/** Notices from Attendly (the platform) are Attendly's to change; the institution only reads them. */
const mayEdit = (auth: AuthContext, r: { author_id: string | null; platform?: boolean }) => !r.platform && (isAdmin(auth) || r.author_id === auth.userId);

function toSummary(auth: AuthContext, r: NoticeRow): NoticeSummary {
  return {
    id: r.id,
    title: r.title,
    preview: richToPlain(r.body, 180),
    category: r.category,
    pinned: r.pinned,
    important: r.important,
    author: r.platform
      ? { id: r.author_id ?? r.id, name: r.author_label ?? 'Attendly', role: (r.author_label ?? 'Attendly') === 'Attendly' ? 'Official' : 'Attendly' }
      : { id: r.author_id ?? r.id, name: r.author_name ?? 'Former staff', role: r.author_role === 'admin' ? 'Admin' : r.author_role === 'teacher' ? 'Professor' : 'Staff' },
    audienceLabel: r.audience_label,
    createdAt: r.created_at.toISOString(),
    editedAt: r.edited_at?.toISOString() ?? null,
    read: r.read,
    reactions: r.reactions,
    canEdit: mayEdit(auth, r),
  };
}

export const audienceLabel = (k: 'everyone' | 'students' | 'staff' | 'admins') => (k === 'everyone' ? 'Everyone' : k === 'students' ? 'All students' : k === 'admins' ? 'All admins' : 'All faculty');

/** Checks the caller may address this audience; returns its label and recipients. */
async function resolveAudience(db: Queryable, auth: AuthContext, a: NoticeAudience): Promise<{ label: string; recipients: string[] }> {
  let label: string;
  if (a.kind === 'everyone' || a.kind === 'students' || a.kind === 'staff' || a.kind === 'admins') {
    if (!can(auth, 'broadcast'))
      throw new ApiError(403, 'FORBIDDEN', 'Notices to the whole institution, all students or all faculty need the “Notices to everyone” permission. You can post to batches and your own subjects.');
    label = audienceLabel(a.kind);
  } else if (a.kind === 'batches') {
    const ids = [...new Set(a.batchIds)];
    const { rows } = await db.query<{ name: string }>('select name from batches where tenant_id = $1 and id = any($2::uuid[]) order by name', [auth.tenantId, ids]);
    if (rows.length !== ids.length) throw new ApiError(400, 'BAD_REQUEST', 'One or more batches do not exist.');
    label = rows.length > 3 ? `${rows.slice(0, 3).map((r) => r.name).join(', ')} +${rows.length - 3}` : rows.map((r) => r.name).join(', ');
  } else {
    const ids = [...new Set(a.courseIds)];
    const { rows } = await db.query<{ code: string; instructor_id: string | null }>('select code, instructor_id from courses where tenant_id = $1 and id = any($2::uuid[]) order by code', [auth.tenantId, ids]);
    if (rows.length !== ids.length) throw new ApiError(400, 'BAD_REQUEST', 'One or more subjects do not exist.');
    if (!can(auth, 'broadcast') && !seesAll(auth) && rows.some((r) => r.instructor_id !== auth.userId))
      throw new ApiError(403, 'FORBIDDEN', 'You can post to the subjects you teach (or to batches).');
    label = rows.length > 3 ? `${rows.slice(0, 3).map((r) => r.code).join(', ')} +${rows.length - 3}` : rows.map((r) => r.code).join(', ');
  }
  const kind = a.kind;
  const { rows } = await db.query<{ id: string }>(
    `select u.id from users u
      where u.tenant_id = $1 and u.status = 'active' and u.id <> $2 and (
        ($3 = 'everyone' and u.role in ('student', 'teacher', 'admin'))
        or ($3 = 'students' and u.role = 'student')
        or ($3 = 'staff' and u.role in ('teacher', 'admin'))
        or ($3 = 'admins' and u.role = 'admin')
        or ($3 = 'batches' and exists (select 1 from batch_members m where m.user_id = u.id and m.batch_id = any($4::uuid[])))
        or ($3 = 'courses' and u.role = 'student' and exists (select 1 from enrollments e where e.user_id = u.id and e.course_id = any($5::uuid[]))))`,
    [auth.tenantId, auth.userId, kind, kind === 'batches' ? a.batchIds : [], kind === 'courses' ? a.courseIds : []],
  );
  return { label, recipients: rows.map((r) => r.id) };
}

async function loadNotice(db: Queryable, auth: AuthContext, id: string): Promise<NoticeRow> {
  const { rows } = await db.query<NoticeRow>(`${SELECT} where n.id = $5 and ${VISIBLE}`, [...params(auth), id]);
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'This notice was removed or isn’t for you.');
  return rows[0];
}

async function toDetail(db: Queryable, auth: AuthContext, r: NoticeRow): Promise<NoticeDetail> {
  const audience: NoticeAudience =
    r.audience === 'batches' ? { kind: 'batches', batchIds: r.batch_ids } : r.audience === 'courses' ? { kind: 'courses', courseIds: r.course_ids } : { kind: r.audience };
  let stats: NoticeDetail['stats'] = null;
  if (mayEdit(auth, r)) {
    const seen = await db.query<{ n: number }>('select count(*)::int as n from notice_reads where notice_id = $1 and user_id is distinct from $2', [r.id, r.author_id]);
    stats = { recipients: r.recipients, seen: seen.rows[0]!.n };
  }
  return { ...toSummary(auth, r), body: r.body, audience, stats };
}

export async function noticeRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/v1/notices', async (req): Promise<NoticesResponse> => {
    const auth = await requireDevice(req, deps, EVERYONE);
    const q = NoticesQuery.parse(req.query);
    const p = params(auth);
    const extra = [
      q.filter === 'unread' ? `and n.author_id is distinct from $2 and not exists (select 1 from notice_reads r where r.notice_id = n.id and r.user_id = $2)` : '',
      q.filter === 'pinned' ? 'and n.pinned' : '',
      q.filter === 'mine' ? 'and n.author_id = $2' : '',
      q.filter === 'all' ? 'and not n.pinned' : '',
      q.category ? 'and n.category = $5' : '',
      q.before ? `and n.created_at < $${q.category ? 6 : 5}` : '',
    ].join(' ');
    const args = [...p, ...(q.category ? [q.category] : []), ...(q.before ? [new Date(q.before)] : [])];
    const [items, pinned, unread] = await Promise.all([
      deps.db.query<NoticeRow>(`${SELECT} where ${VISIBLE} ${extra} order by n.created_at desc limit ${PAGE + 1}`, args),
      q.filter === 'all' && !q.before
        ? deps.db.query<NoticeRow>(`${SELECT} where ${VISIBLE} and n.pinned ${q.category ? 'and n.category = $5' : ''} order by n.created_at desc limit 10`, [...p, ...(q.category ? [q.category] : [])])
        : Promise.resolve({ rows: [] as NoticeRow[] }),
      deps.db.query<{ n: number }>(
        `select count(*)::int as n from notices n where ${VISIBLE} and n.author_id is distinct from $2
            and not exists (select 1 from notice_reads r where r.notice_id = n.id and r.user_id = $2)`,
        p,
      ),
    ]);
    const more = items.rows.length > PAGE;
    const page = items.rows.slice(0, PAGE);
    return {
      pinned: pinned.rows.map((r) => toSummary(auth, r)),
      items: page.map((r) => toSummary(auth, r)),
      unread: unread.rows[0]!.n,
      nextBefore: more ? page[page.length - 1]!.created_at.toISOString() : null,
    };
  });

  /** Opening a notice marks it read. */
  app.get('/v1/notices/:id', async (req): Promise<NoticeDetail> => {
    const auth = await requireDevice(req, deps, EVERYONE);
    const { id } = IdParam.parse(req.params);
    const r = await loadNotice(deps.db, auth, id);
    if (!r.read) {
      await deps.db.query('insert into notice_reads(notice_id, user_id) values ($1, $2) on conflict do nothing', [id, auth.userId]);
      await deps.db.query(`update notifications set read_at = now() where user_id = $1 and kind = 'notice' and data->>'noticeId' = $2 and read_at is null`, [auth.userId, id]);
      r.read = true;
    }
    return toDetail(deps.db, auth, r);
  });

  /** The people a notice reached, split into who has opened it (latest first) and who hasn't. */
  app.get('/v1/notices/:id/readers', async (req): Promise<NoticeReaders> => {
    const auth = await requireDevice(req, deps, EVERYONE);
    const { id } = IdParam.parse(req.params);
    const r = await loadNotice(deps.db, auth, id);
    if (!mayEdit(auth, r)) throw new ApiError(403, 'FORBIDDEN', 'Only the author and admins can see who has read a notice.');
    const { rows } = await deps.db.query<{ id: string; full_name: string; role: 'student' | 'teacher' | 'admin'; roll_no: string | null; read_at: Date | null }>(
      `select u.id, u.full_name, u.role, u.roll_no, rd.read_at
         from (select user_id from notifications where kind = 'notice' and data->>'noticeId' = $3
               union select user_id from notice_reads where notice_id = $1) x
         join users u on u.id = x.user_id
         left join notice_reads rd on rd.notice_id = $1 and rd.user_id = u.id
        where u.id is distinct from $2 and u.role in ('student', 'teacher', 'admin')
        order by rd.read_at desc nulls last, u.full_name`,
      [id, r.author_id, id],
    );
    const out = rows.map((x) => ({ id: x.id, name: x.full_name, role: x.role, rollNo: x.roll_no, readAt: x.read_at?.toISOString() ?? null }));
    return { seen: out.filter((x) => x.readAt), notSeen: out.filter((x) => !x.readAt) };
  });

  app.post('/v1/notices/read-all', async (req) => {
    const auth = await requireDevice(req, deps, EVERYONE);
    await deps.db.query(`insert into notice_reads(notice_id, user_id) select n.id, $2 from notices n where ${VISIBLE} on conflict do nothing`, params(auth));
    return { ok: true as const };
  });

  /** "Send to N people" before posting. */
  app.post('/v1/notices/audience', async (req): Promise<AudienceCountResponse> => {
    const auth = await requireDevice(req, deps, ['teacher', 'admin']);
    const a = NoticeAudience.parse(req.body);
    const r = await resolveAudience(deps.db, auth, a);
    return { recipients: r.recipients.length, label: r.label };
  });

  app.post('/v1/notices', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<NoticeDetail> => {
    const auth = await requireDevice(req, deps, ['teacher', 'admin']);
    const b = NoticeBody.parse(req.body);
    const id = await withTx(deps.db, async (tx) => {
      const aud = await resolveAudience(tx, auth, b.audience);
      const { rows } = await tx.query<{ id: string }>(
        `insert into notices(tenant_id, author_id, title, body, category, audience, batch_ids, course_ids, audience_label, pinned, important, recipients)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [
          auth.tenantId,
          auth.userId,
          b.title,
          b.body,
          b.category,
          b.audience.kind,
          b.audience.kind === 'batches' ? [...new Set(b.audience.batchIds)] : [],
          b.audience.kind === 'courses' ? [...new Set(b.audience.courseIds)] : [],
          aud.label,
          b.pinned,
          b.important,
          aud.recipients.length,
        ],
      );
      const noticeId = rows[0]!.id;
      const me = await tx.query<{ full_name: string }>('select full_name from users where id = $1', [auth.userId]);
      const emoji = NOTICE_CATEGORIES.find((c) => c.key === b.category)?.emoji ?? '📢';
      const preview = richToPlain(b.body, 160);
      await insertNotifications(
        tx,
        auth.tenantId,
        aud.recipients.map((userId) => ({
          userId,
          kind: 'notice',
          title: `${b.important ? '⚠️ Important · ' : `${emoji} `}${b.title}`,
          body: `${me.rows[0]?.full_name ?? 'Notice'}: ${preview}`,
          data: { noticeId },
        })),
      );
      await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'notice.send', subject: `notice:${noticeId}`, data: { audience: aud.label, recipients: aud.recipients.length } });
      return noticeId;
    });
    return toDetail(deps.db, auth, await loadNotice(deps.db, auth, id));
  });

  app.post('/v1/notices/:id', async (req): Promise<NoticeDetail> => {
    const auth = await requireDevice(req, deps, ['teacher', 'admin']);
    const { id } = IdParam.parse(req.params);
    const b = NoticeUpdateBody.parse(req.body);
    const cur = await loadNotice(deps.db, auth, id);
    if (!mayEdit(auth, cur)) throw new ApiError(403, 'FORBIDDEN', 'Only the author or an admin can edit this notice.');
    await deps.db.query(
      `update notices set title = coalesce($2, title), body = coalesce($3, body), category = coalesce($4, category),
              pinned = coalesce($5, pinned), important = coalesce($6, important), edited_at = now() where id = $1`,
      [id, b.title ?? null, b.body ?? null, b.category ?? null, b.pinned ?? null, b.important ?? null],
    );
    return toDetail(deps.db, auth, await loadNotice(deps.db, auth, id));
  });

  app.post('/v1/notices/:id/delete', async (req) => {
    const auth = await requireDevice(req, deps, ['teacher', 'admin']);
    const { id } = IdParam.parse(req.params);
    const cur = await loadNotice(deps.db, auth, id);
    if (!mayEdit(auth, cur)) throw new ApiError(403, 'FORBIDDEN', 'Only the author or an admin can delete this notice.');
    await withTx(deps.db, async (tx) => {
      await tx.query('update notices set deleted_at = now() where id = $1', [id]);
      await tx.query(`delete from notifications where kind = 'notice' and data->>'noticeId' = $1`, [id]);
      await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'notice.delete', subject: `notice:${id}` });
    });
    return { ok: true as const };
  });

  /** Tap an emoji to add your reaction; tap it again to take it back. */
  app.post('/v1/notices/:id/react', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req): Promise<NoticeSummary['reactions']> => {
    const auth = await requireDevice(req, deps, EVERYONE);
    const { id } = IdParam.parse(req.params);
    const { emoji } = ReactBody.parse(req.body);
    await loadNotice(deps.db, auth, id);
    const del = await deps.db.query('delete from notice_reactions where notice_id = $1 and user_id = $2 and emoji = $3', [id, auth.userId, emoji]);
    if (!del.rowCount) await deps.db.query('insert into notice_reactions(notice_id, user_id, emoji) values ($1, $2, $3) on conflict do nothing', [id, auth.userId, emoji]);
    return (await loadNotice(deps.db, auth, id)).reactions;
  });
}
