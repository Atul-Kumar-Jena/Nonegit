/**
 * Timetable v2: batches, the drag-and-drop planner (drafts → publish), one-off
 * adjustments by teachers, "who is busy where", and notifications.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AdjustBody,
  BatchBody,
  BatchUpdateBody,
  CreateDraftBody,
  DraftOps,
  PublishBody,
  ReadNotificationsBody,
  SaveDraftBody,
  YMD,
  opCounts,
  type Availability,
  type Batch,
  type BatchDetail,
  type BusyBlock,
  type Draft,
  type DraftSummary,
  type NotificationsResponse,
  type PlannerWeek,
  type PublishResponse,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { STAFF, loadSessionFor, requireAdmin } from '../lib/access';
import { requireDevice, requireDeviceKeyOnly, type AuthContext } from '../lib/auth';
import { reconcileBatchEnrollments } from '../lib/batches';
import { ApiError } from '../lib/errors';
import { loadPlannerWeek, localNow, publishOps } from '../lib/planner-server';
import { localDayBounds } from '../lib/staff-sessions';
import { materializeTimetable } from '../lib/timetable';
import { loadInstitution, staffAudit } from './staff-admin';

const IdParam = z.object({ id: z.uuid() });

async function loadBatch(db: Queryable, auth: AuthContext, id: string): Promise<Batch> {
  const { rows } = await db.query<{ id: string; name: string; active: boolean; size: number; course_ids: string[] }>(
    `select b.id, b.name, b.active,
            (select count(*)::int from batch_members m where m.batch_id = b.id) as size,
            coalesce((select array_agg(cb.course_id) from course_batches cb where cb.batch_id = b.id), '{}') as course_ids
       from batches b where b.id = $1 and b.tenant_id = $2`,
    [id, auth.tenantId],
  );
  const b = rows[0];
  if (!b) throw new ApiError(404, 'NOT_FOUND', 'Batch not found.');
  return { id: b.id, name: b.name, active: b.active, size: b.size, courseIds: b.course_ids };
}

interface DraftRow {
  id: string;
  title: string;
  week_start: string;
  status: Draft['status'];
  version: number;
  ops: unknown;
  note: string | null;
  updated_at: Date;
  updated_by_name: string | null;
  published_at: Date | null;
}
const DRAFT_SELECT = `
  select d.id, d.title, to_char(d.week_start, 'YYYY-MM-DD') as week_start, d.status, d.version, d.ops, d.note, d.updated_at, d.published_at,
         u.full_name as updated_by_name
    from timetable_drafts d left join users u on u.id = d.updated_by`;

function toDraft(r: DraftRow): Draft {
  const parsed = DraftOps.safeParse(r.ops);
  const ops = parsed.success ? parsed.data : [];
  const counts = opCounts(ops);
  return {
    id: r.id,
    title: r.title,
    weekStart: r.week_start,
    status: r.status,
    version: r.version,
    once: counts.once,
    weekly: counts.weekly,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by_name,
    publishedAt: r.published_at?.toISOString() ?? null,
    ops,
    note: r.note,
  };
}
const summary = (d: Draft): DraftSummary => {
  const { ops: _ops, note: _note, ...rest } = d;
  return rest;
};

export async function staffPlannerRoutes(app: FastifyInstance, deps: Deps) {
  const now = () => new Date(deps.clock());

  // ───────────── batches ─────────────

  app.get('/v1/staff/batches', async (req): Promise<Batch[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { rows } = await deps.db.query<{ id: string }>('select id from batches where tenant_id = $1 order by active desc, name', [auth.tenantId]);
    return Promise.all(rows.map((r) => loadBatch(deps.db, auth, r.id)));
  });

  app.get('/v1/staff/batches/:id', async (req): Promise<BatchDetail> => {
    const auth = await requireDevice(req, deps, STAFF);
    const b = await loadBatch(deps.db, auth, IdParam.parse(req.params).id);
    const { rows } = await deps.db.query<{ id: string; full_name: string; roll_no: string | null }>(
      `select u.id, u.full_name, u.roll_no from batch_members m join users u on u.id = m.user_id where m.batch_id = $1 order by u.roll_no nulls last, u.full_name`,
      [b.id],
    );
    return { ...b, members: rows.map((r) => ({ userId: r.id, fullName: r.full_name, rollNo: r.roll_no })) };
  });

  app.post('/v1/staff/batches', async (req): Promise<Batch> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const b = BatchBody.parse(req.body);
    try {
      const id = await withTx(deps.db, async (tx) => {
        const { rows } = await tx.query<{ id: string }>('insert into batches(tenant_id, name, active) values ($1, $2, $3) returning id', [auth.tenantId, b.name, b.active]);
        await staffAudit(tx, auth, 'batch.create', `batch:${rows[0]!.id}`, { name: b.name });
        return rows[0]!.id;
      });
      return loadBatch(deps.db, auth, id);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'CONFLICT', `A batch called “${b.name}” already exists.`);
      throw err;
    }
  });

  app.post('/v1/staff/batches/:id', async (req): Promise<BatchDetail> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const { id } = IdParam.parse(req.params);
    const b = BatchUpdateBody.parse(req.body);
    try {
      await withTx(deps.db, async (tx) => {
        await loadBatch(tx, auth, id);
        await tx.query('select 1 from batches where id = $1 for update', [id]);
        if (b.name !== undefined || b.active !== undefined)
          await tx.query('update batches set name = coalesce($2, name), active = coalesce($3, active) where id = $1', [id, b.name ?? null, b.active ?? null]);
        const add = [...new Set(b.addMembers)];
        if (add.length) {
          const ok = await tx.query(`select 1 from users where tenant_id = $1 and role = 'student' and id = any($2::uuid[])`, [auth.tenantId, add]);
          if (ok.rowCount !== add.length) throw new ApiError(400, 'BAD_REQUEST', 'Only students of this institution can be in a batch.');
          await tx.query('insert into batch_members(batch_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing', [id, add]);
        }
        if (b.removeMembers.length) await tx.query('delete from batch_members where batch_id = $1 and user_id = any($2::uuid[])', [id, b.removeMembers]);
        if (b.courseIds) {
          const courses = [...new Set(b.courseIds)];
          if (courses.length) {
            const ok = await tx.query('select 1 from courses where tenant_id = $1 and id = any($2::uuid[])', [auth.tenantId, courses]);
            if (ok.rowCount !== courses.length) throw new ApiError(400, 'BAD_REQUEST', 'One or more courses do not exist.');
          }
          await tx.query('delete from course_batches where batch_id = $1 and not (course_id = any($2::uuid[]))', [id, courses]);
          await tx.query('insert into course_batches(course_id, batch_id) select unnest($2::uuid[]), $1 on conflict do nothing', [id, courses]);
        }
        await reconcileBatchEnrollments(tx, auth.tenantId);
        await staffAudit(tx, auth, 'batch.update', `batch:${id}`, { added: add.length, removed: b.removeMembers.length, courses: b.courseIds?.length ?? null, name: b.name ?? null });
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'CONFLICT', 'Another batch already has that name.');
      throw err;
    }
    const detail = await loadBatch(deps.db, auth, id);
    const { rows } = await deps.db.query<{ id: string; full_name: string; roll_no: string | null }>(
      `select u.id, u.full_name, u.roll_no from batch_members m join users u on u.id = m.user_id where m.batch_id = $1 order by u.roll_no nulls last, u.full_name`,
      [id],
    );
    return { ...detail, members: rows.map((r) => ({ userId: r.id, fullName: r.full_name, rollNo: r.roll_no })) };
  });

  // ───────────── planner & drafts (admins) ─────────────

  app.get('/v1/staff/planner', async (req): Promise<PlannerWeek> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const q = z.object({ week: YMD.optional() }).parse(req.query);
    const inst = await loadInstitution(deps.db, auth.tenantId);
    const week = q.week ?? (await localNow(deps.db, inst.timezone, deps.clock())).today;
    return loadPlannerWeek(deps.db, deps, auth, week);
  });

  app.get('/v1/staff/drafts', async (req): Promise<DraftSummary[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const { rows } = await deps.db.query<DraftRow>(`${DRAFT_SELECT} where d.tenant_id = $1 and (d.status = 'draft' or d.updated_at > now() - interval '30 days') order by (d.status = 'draft') desc, d.updated_at desc limit 50`, [auth.tenantId]);
    return rows.map((r) => summary(toDraft(r)));
  });

  const loadDraft = async (db: Queryable, auth: AuthContext, id: string, forUpdate = false): Promise<Draft> => {
    const { rows } = await db.query<DraftRow>(`${DRAFT_SELECT} where d.id = $1 and d.tenant_id = $2${forUpdate ? ' for update of d' : ''}`, [id, auth.tenantId]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Draft not found.');
    return toDraft(rows[0]);
  };

  app.post('/v1/staff/drafts', async (req): Promise<Draft> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const b = CreateDraftBody.parse(req.body);
    const { rows } = await deps.db.query<{ id: string }>(
      `insert into timetable_drafts(tenant_id, title, week_start, created_by, updated_by) values ($1, $2, $3, $4, $4) returning id`,
      [auth.tenantId, b.title, b.weekStart, auth.userId],
    );
    return loadDraft(deps.db, auth, rows[0]!.id);
  });

  app.get('/v1/staff/drafts/:id', async (req): Promise<Draft> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    return loadDraft(deps.db, auth, IdParam.parse(req.params).id);
  });

  /** Save the whole list of changes. `version` must match: two admins never overwrite each other silently. */
  app.post('/v1/staff/drafts/:id', async (req): Promise<Draft> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const { id } = IdParam.parse(req.params);
    const b = SaveDraftBody.parse(req.body);
    return withTx(deps.db, async (tx) => {
      const d = await loadDraft(tx, auth, id, true);
      if (d.status !== 'draft') throw new ApiError(409, 'CONFLICT', `This draft was already ${d.status}.`);
      if (d.version !== b.version) throw new ApiError(409, 'CONFLICT', `${d.updatedBy ?? 'Someone'} changed this draft meanwhile. Reload it to see their changes.`);
      await tx.query(`update timetable_drafts set ops = $2::jsonb, title = coalesce($3, title), version = version + 1, updated_by = $4, updated_at = $5 where id = $1`, [
        id,
        JSON.stringify(b.ops),
        b.title ?? null,
        auth.userId,
        now(),
      ]);
      return loadDraft(tx, auth, id);
    });
  });

  /** Server-side check of a draft (same engine as the app), without changing anything. */
  app.post('/v1/staff/drafts/:id/check', async (req): Promise<PublishResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const { id } = IdParam.parse(req.params);
    return withTx(deps.db, async (tx) => {
      const d = await loadDraft(tx, auth, id);
      if (!d.ops.length) return { published: false, applied: 0, notified: 0, conflicts: [], errors: [] };
      const { published, applied, notified, conflicts, errors } = await publishOps(tx, deps, auth, d.ops, { dryRun: true, acceptWarnings: true });
      return { published, applied, notified, conflicts, errors };
    });
  });

  app.post('/v1/staff/drafts/:id/publish', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<PublishResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const { id } = IdParam.parse(req.params);
    const b = PublishBody.parse(req.body);
    const result = await withTx(deps.db, async (tx) => {
      const d = await loadDraft(tx, auth, id, true);
      if (d.status !== 'draft') throw new ApiError(409, 'CONFLICT', `This draft was already ${d.status}.`);
      if (d.version !== b.version) throw new ApiError(409, 'CONFLICT', 'The draft changed since you last saw it. Reload it before publishing.');
      const r = await publishOps(tx, deps, auth, d.ops, { acceptWarnings: b.acceptWarnings, note: b.note ?? null });
      if (r.published)
        await tx.query(`update timetable_drafts set status = 'published', published_at = $2, published_by = $3, note = $4, updated_at = $2 where id = $1`, [id, now(), auth.userId, b.note ?? null]);
      return r;
    });
    if (result.slotsToMaterialize.length) for (const slotId of result.slotsToMaterialize) await materializeTimetable(deps.db, { slotId });
    const { published, applied, notified, conflicts, errors } = result;
    return { published, applied, notified, conflicts, errors };
  });

  app.post('/v1/staff/drafts/:id/discard', async (req): Promise<DraftSummary> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const { id } = IdParam.parse(req.params);
    return withTx(deps.db, async (tx) => {
      const d = await loadDraft(tx, auth, id, true);
      if (d.status !== 'draft') throw new ApiError(409, 'CONFLICT', `This draft was already ${d.status}.`);
      await tx.query(`update timetable_drafts set status = 'discarded', updated_by = $2, updated_at = $3 where id = $1`, [id, auth.userId, now()]);
      return summary(await loadDraft(tx, auth, id));
    });
  });

  // ───────────── one-off adjustment of one class (its teacher or an admin) ─────────────

  app.post('/v1/staff/sessions/:id/adjust', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<PublishResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const b = AdjustBody.parse(req.body);
    if (!('sessionId' in b.change) || b.change.sessionId !== id) throw new ApiError(400, 'BAD_REQUEST', 'The change must be for this class.');
    const r = await withTx(deps.db, async (tx) => {
      await loadSessionFor(tx, auth, id); // outside the caller's scope → 404, never "exists but refused"
      return publishOps(tx, deps, auth, [b.change], { acceptWarnings: b.acceptWarnings });
    });
    const { published, applied, notified, conflicts, errors } = r;
    return { published, applied, notified, conflicts, errors };
  });

  // ───────────── who is busy where ─────────────

  app.get('/v1/staff/availability', async (req): Promise<Availability> => {
    const auth = await requireDevice(req, deps, STAFF);
    const q = z.object({ date: YMD.optional(), days: z.coerce.number().int().min(1).max(7).default(1) }).parse(req.query);
    const inst = await loadInstitution(deps.db, auth.tenantId);
    const range = await localDayBounds(deps.db, inst.timezone, q.date ?? null, q.days);
    const [people, rooms, sessions] = await Promise.all([
      deps.db.query<{ id: string; full_name: string; role: string }>(
        `select id, full_name, role from users where tenant_id = $1 and role in ('teacher', 'admin') and status = 'active' order by full_name`,
        [auth.tenantId],
      ),
      deps.db.query<{ id: string; name: string }>('select id, name from rooms where tenant_id = $1 and active order by name', [auth.tenantId]),
      deps.db.query<{
        id: string;
        course_id: string;
        code: string;
        title: string;
        teacher_id: string | null;
        substitute: boolean;
        room_id: string | null;
        room: string | null;
        status: string;
        date: string;
        start_hm: string;
        end_hm: string;
      }>(
        `select s.id, s.course_id, c.code, c.title, coalesce(s.substitute_id, c.instructor_id) as teacher_id, s.substitute_id is not null as substitute,
                s.room_id, coalesce(r.name, s.room) as room, s.status,
                to_char(s.scheduled_start at time zone $2, 'YYYY-MM-DD') as date,
                to_char(s.scheduled_start at time zone $2, 'HH24:MI') as start_hm,
                to_char(s.scheduled_end at time zone $2, 'HH24:MI') as end_hm
           from class_sessions s join courses c on c.id = s.course_id left join rooms r on r.id = s.room_id
          where s.tenant_id = $1 and s.status <> 'cancelled' and s.scheduled_start >= $3 and s.scheduled_start < $4
          order by s.scheduled_start`,
        [auth.tenantId, inst.timezone, range.from, range.to],
      ),
    ]);
    const block = (s: (typeof sessions.rows)[number]): BusyBlock => ({
      sessionId: s.id,
      courseId: s.course_id,
      courseCode: s.code,
      courseTitle: s.title,
      date: s.date,
      start: s.start_hm,
      end: s.end_hm,
      room: s.room,
      substitute: s.substitute,
      status: s.status,
    });
    return {
      from: range.ymd,
      days: q.days,
      timezone: inst.timezone,
      teachers: people.rows.map((p) => ({ id: p.id, name: p.full_name, role: p.role, busy: sessions.rows.filter((s) => s.teacher_id === p.id).map(block) })),
      rooms: rooms.rows.map((r) => ({ id: r.id, name: r.name, busy: sessions.rows.filter((s) => s.room_id === r.id).map(block) })),
    };
  });

  // ───────────── notifications (everyone: students and staff) ─────────────

  app.get('/v1/notifications', async (req): Promise<NotificationsResponse> => {
    const auth = await requireDevice(req, deps);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const [items, unread] = await Promise.all([
      deps.db.query<{ id: string; kind: string; title: string; body: string; data: Record<string, unknown>; created_at: Date; read_at: Date | null }>(
        `select id, kind, title, body, data, created_at, read_at from notifications where user_id = $1 order by id desc limit $2`,
        [auth.userId, q.limit],
      ),
      deps.db.query<{ n: number }>(`select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [auth.userId]),
    ]);
    return {
      items: items.rows.map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, body: r.body, data: r.data, createdAt: r.created_at.toISOString(), read: !!r.read_at })),
      unread: unread.rows[0]!.n,
    };
  });

  /** Background check (device key only, read-only): new unread notifications after `after`. */
  app.get('/v1/notifications/poll', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<NotificationsResponse> => {
    const who = await requireDeviceKeyOnly(req, deps);
    const q = z.object({ after: z.coerce.number().int().nonnegative().default(0) }).parse(req.query);
    const [items, unread] = await Promise.all([
      deps.db.query<{ id: string; kind: string; title: string; body: string; data: Record<string, unknown>; created_at: Date }>(
        `select id, kind, title, body, data, created_at from notifications where user_id = $1 and read_at is null and id > $2 order by id limit 10`,
        [who.userId, q.after],
      ),
      deps.db.query<{ n: number }>(`select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [who.userId]),
    ]);
    return {
      items: items.rows.map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, body: r.body, data: r.data, createdAt: r.created_at.toISOString(), read: false })),
      unread: unread.rows[0]!.n,
    };
  });

  app.post('/v1/notifications/read', async (req) => {
    const auth = await requireDevice(req, deps);
    const b = ReadNotificationsBody.parse(req.body);
    if (b.all) await deps.db.query('update notifications set read_at = $2 where user_id = $1 and read_at is null', [auth.userId, now()]);
    else if (b.ids.length) await deps.db.query('update notifications set read_at = $3 where user_id = $1 and id = any($2::bigint[]) and read_at is null', [auth.userId, b.ids, now()]);
    return { ok: true as const };
  });

}
