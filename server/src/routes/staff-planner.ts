/**
 * Timetable v2: batches, the drag-and-drop planner (drafts → publish), one-off
 * adjustments by teachers, "who is busy where", and notifications.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type DraftOp,
  AdjustBody,
  CreateDraftBody,
  DraftOps,
  PublishBody,
  ReadNotificationsBody,
  SaveDraftBody,
  YMD,
  opCounts,
  type Availability,
  type BusyBlock,
  type Draft,
  type DraftSummary,
  type NotificationsResponse,
  type PlannerWeek,
  type PublishResponse,
} from '@attendly/protocol';
import type { PoolClient } from 'pg';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { STAFF, loadSessionFor, requirePerm } from '../lib/access';
import { perDeviceKey, requireDevice, requireDeviceKeyOnly, type AuthContext } from '../lib/auth';
import { insertNotifications } from '../lib/notify';
import { ApiError } from '../lib/errors';
import { loadPlannerWeek, localNow, publishOps } from '../lib/planner-server';
import { createCoverRequest, needsApproval } from '../lib/requests';
import { localDayBounds } from '../lib/staff-sessions';
import { materializeTimetable } from '../lib/timetable';
import { pushAppOf, pushConfig } from '../lib/push';
import { loadInstitution, staffAudit } from './staff-admin';

const IdParam = z.object({ id: z.uuid() });

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
  /**
   * Publishes changes, except that handing a class to another teacher becomes a request that
   * teacher has to accept (see lib/requests). Everything is validated together first, and it is
   * all-or-nothing: a request that can't be sent rolls the whole publish back.
   */
  async function publishWithApprovals(
    tx: PoolClient,
    auth: AuthContext,
    ops: DraftOp[],
    opts: { acceptWarnings: boolean; note: string | null },
    onPublished?: () => Promise<void>,
  ) {
    const check = await publishOps(tx, deps, auth, ops, { dryRun: true, acceptWarnings: opts.acceptWarnings });
    const refused = check.errors.length > 0 || check.conflicts.some((c) => c.severity === 'error') || (check.conflicts.length > 0 && !opts.acceptWarnings);
    if (refused) return check;
    const asks: Extract<DraftOp, { op: 'substitute' }>[] = [];
    const direct: DraftOp[] = [];
    for (const o of ops) {
      if (o.op === 'substitute' && (await needsApproval(tx, auth, o))) asks.push(o);
      else direct.push(o);
    }
    const r = direct.length
      ? await publishOps(tx, deps, auth, direct, { acceptWarnings: true, note: opts.note })
      : { ...check, published: true, applied: 0, notified: 0, created: {}, slotsToMaterialize: [] as string[] };
    for (const o of asks) {
      const c = await createCoverRequest(tx, deps, auth, {
        sessionId: o.sessionId,
        teacherId: o.teacherId!,
        noteToTeacher: o.noteToTeacher,
        noteToStudents: o.noteToStudents || opts.note || undefined,
        mode: 'ask',
        acceptWarnings: true,
      });
      if (c.status === 'refused') throw new ApiError(409, 'CONFLICT', c.errors[0]?.message ?? c.conflicts[0]?.message ?? 'A teacher could not be asked to take a class.');
      r.notified += c.notified;
    }
    if (onPublished) await onPublished();
    return { ...r, published: true, requested: asks.length };
  }

  const now = () => new Date(deps.clock());

  // ───────────── planner & drafts (admins) ─────────────

  app.get('/v1/staff/planner', async (req): Promise<PlannerWeek> => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'planner');
    const q = z.object({ week: YMD.optional() }).parse(req.query);
    const inst = await loadInstitution(deps.db, auth.tenantId);
    const week = q.week ?? (await localNow(deps.db, inst.timezone, deps.clock())).today;
    return loadPlannerWeek(deps.db, deps, auth, week);
  });

  app.get('/v1/staff/drafts', async (req): Promise<DraftSummary[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'planner');
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
    requirePerm(auth, 'planner');
    const b = CreateDraftBody.parse(req.body);
    const { rows } = await deps.db.query<{ id: string }>(
      `insert into timetable_drafts(tenant_id, title, week_start, created_by, updated_by) values ($1, $2, $3, $4, $4) returning id`,
      [auth.tenantId, b.title, b.weekStart, auth.userId],
    );
    return loadDraft(deps.db, auth, rows[0]!.id);
  });

  app.get('/v1/staff/drafts/:id', async (req): Promise<Draft> => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'planner');
    return loadDraft(deps.db, auth, IdParam.parse(req.params).id);
  });

  /** Save the whole list of changes. `version` must match: two admins never overwrite each other silently. */
  app.post('/v1/staff/drafts/:id', async (req): Promise<Draft> => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'planner');
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
    requirePerm(auth, 'planner');
    const { id } = IdParam.parse(req.params);
    return withTx(deps.db, async (tx) => {
      const d = await loadDraft(tx, auth, id);
      if (!d.ops.length) return { published: false, applied: 0, notified: 0, conflicts: [], errors: [], requested: 0 };
      const { published, applied, notified, conflicts, errors } = await publishOps(tx, deps, auth, d.ops, { dryRun: true, acceptWarnings: true });
      let requested = 0;
      for (const o of d.ops) if (await needsApproval(tx, auth, o)) requested++;
      return { published, applied, notified, conflicts, errors, requested };
    });
  });

  app.post('/v1/staff/drafts/:id/publish', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<PublishResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'planner');
    const { id } = IdParam.parse(req.params);
    const b = PublishBody.parse(req.body);
    const result = await withTx(deps.db, async (tx) => {
      const d = await loadDraft(tx, auth, id, true);
      if (d.status !== 'draft') throw new ApiError(409, 'CONFLICT', `This draft was already ${d.status}.`);
      if (d.version !== b.version) throw new ApiError(409, 'CONFLICT', 'The draft changed since you last saw it. Reload it before publishing.');
      return publishWithApprovals(tx, auth, d.ops, { acceptWarnings: b.acceptWarnings, note: b.note ?? null }, async () => {
        await tx.query(`update timetable_drafts set status = 'published', published_at = $2, published_by = $3, note = $4, updated_at = $2 where id = $1`, [id, now(), auth.userId, b.note ?? null]);
      });
    });
    if (result.slotsToMaterialize.length) for (const slotId of result.slotsToMaterialize) await materializeTimetable(deps.db, { slotId });
    const { published, applied, notified, conflicts, errors, requested } = result;
    return { published, applied, notified, conflicts, errors, requested };
  });

  app.post('/v1/staff/drafts/:id/discard', async (req): Promise<DraftSummary> => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'planner');
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
      return publishWithApprovals(tx, auth, [b.change], { acceptWarnings: b.acceptWarnings, note: b.note ?? null });
    });
    const { published, applied, notified, conflicts, errors, requested } = r;
    return { published, applied, notified, conflicts, errors, requested };
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
                -- A class that ended early frees its teacher and room from then on, not at its scheduled end.
                to_char((case when s.status = 'closed' and s.ended_at is not null and s.ended_at > s.scheduled_start
                                   and s.ended_at < s.scheduled_end then s.ended_at else s.scheduled_end end) at time zone $2, 'HH24:MI') as end_hm
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
      deps.db.query<{ id: string; kind: string; title: string; body: string; data: Record<string, unknown>; created_at: Date; read_at: Date | null; push_ok: boolean }>(
        `select id, kind, title, body, data, created_at, read_at, push_ok from notifications where user_id = $1 order by id desc limit $2`,
        [auth.userId, q.limit],
      ),
      deps.db.query<{ n: number }>(`select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [auth.userId]),
    ]);
    return {
      items: items.rows.map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, body: r.body, data: r.data, createdAt: r.created_at.toISOString(), read: !!r.read_at, pushed: r.push_ok })),
      unread: unread.rows[0]!.n,
    };
  });

  /** Background check (device key only, read-only): new unread notifications after `after`. */
  app.get('/v1/notifications/poll', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<NotificationsResponse> => {
    const who = await requireDeviceKeyOnly(req, deps);
    const q = z.object({ after: z.coerce.number().int().nonnegative().default(0) }).parse(req.query);
    const [items, unread] = await Promise.all([
      deps.db.query<{ id: string; kind: string; title: string; body: string; data: Record<string, unknown>; created_at: Date; push_ok: boolean }>(
        `select id, kind, title, body, data, created_at, push_ok from notifications where user_id = $1 and read_at is null and id > $2 order by id limit 10`,
        [who.userId, q.after],
      ),
      deps.db.query<{ n: number }>(`select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [who.userId]),
    ]);
    return {
      items: items.rows.map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, body: r.body, data: r.data, createdAt: r.created_at.toISOString(), read: false, pushed: r.push_ok })),
      unread: unread.rows[0]!.n,
    };
  });

  /** The phone's Firebase token, so notifications arrive instantly even when the app is closed. */
  const push = pushConfig();
  const pushOn = (role: string) => {
    const a = pushAppOf(role);
    return !!a && push[a] !== null;
  };
  app.post('/v1/me/push-token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireDevice(req, deps);
    const b = z.object({ token: z.string().min(10).max(4096), platform: z.enum(['android', 'ios']) }).parse(req.body);
    await deps.db.query(
      `insert into push_tokens(device_id, user_id, token, platform, updated_at) values ($1, $2, $3, $4, now())
       on conflict (device_id) do update set token = excluded.token, platform = excluded.platform, user_id = excluded.user_id, updated_at = now()`,
      [auth.deviceId, auth.userId, b.token, b.platform],
    );
    return { ok: true as const, push: pushOn(auth.role) };
  });

  /**
   * "Send me a test notification": a real one through the normal pipeline, so a person can close the
   * app and see whether this phone gets instant notifications. Says what the server knows about it.
   */
  app.post('/v1/me/test-notification', { config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: perDeviceKey } } }, async (req) => {
    const auth = await requireDevice(req, deps);
    const tok = await deps.db.query('select 1 from push_tokens where device_id = $1', [auth.deviceId]);
    await insertNotifications(deps.db, auth.tenantId, [
      {
        userId: auth.userId,
        kind: 'test',
        title: '🔔 Test notification',
        body: 'It works! If this arrived while Attendly was closed, instant notifications are on for this phone.',
        data: {},
      },
    ]);
    return { ok: true as const, serverPush: pushOn(auth.role), phoneRegistered: (tok.rowCount ?? 0) > 0 };
  });

  app.post('/v1/notifications/read', async (req) => {
    const auth = await requireDevice(req, deps);
    const b = ReadNotificationsBody.parse(req.body);
    if (b.all) await deps.db.query('update notifications set read_at = $2 where user_id = $1 and read_at is null', [auth.userId, now()]);
    else if (b.ids.length) await deps.db.query('update notifications set read_at = $3 where user_id = $1 and id = any($2::bigint[]) and read_at is null', [auth.userId, b.ids, now()]);
    return { ok: true as const };
  });

}
