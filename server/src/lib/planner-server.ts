/**
 * Server side of the timetable planner: builds the week view the shared engine
 * works on, and publishes drafts / one-off adjustments atomically:
 *
 *   validate (same engine as the app) → refuse on errors or clashes →
 *   apply every change in one transaction → notify exactly the people affected.
 */
import {
  DraftOps,
  applyOps,
  findConflicts,
  mondayOf,
  addDaysYmd,
  type DraftOp,
  type OpError,
  type PlannerConflict,
  type PlannerCourse,
  type PlannerItem,
  type PlannerWeek,
  type PublishResponse,
  type SessionMode,
} from '@attendly/protocol';
import type { PoolClient } from 'pg';
import type { Deps } from '../deps';
import type { Queryable } from '../db';
import { SLOT_SELECT, toSlot, type SlotRow } from '../routes/staff-academics';
import { loadInstitution, staffAudit } from '../routes/staff-admin';
import { isAdmin, isOwnerOf, loadCourseFor, loadSessionFor } from './access';
import type { AuthContext } from './auth';
import { ApiError } from './errors';
import { WEEKDAY_NAMES, deliverChanges, fmtWhen, type ChangeLine } from './notify';
import { createSession } from './sessions';
import { clearFutureOccurrences } from './timetable';

/** Local "now" of the institution, from the server clock (tests move it). */
export async function localNow(db: Queryable, tz: string, nowMs: number): Promise<{ today: string; now: string }> {
  const { rows } = await db.query<{ today: string; now: string }>(
    `select to_char(($1::timestamptz) at time zone $2, 'YYYY-MM-DD') as today, to_char(($1::timestamptz) at time zone $2, 'HH24:MI') as now`,
    [new Date(nowMs), tz],
  );
  return rows[0]!;
}

async function localToUtc(db: Queryable, date: string, hm: string, tz: string): Promise<Date> {
  const { rows } = await db.query<{ t: Date }>(`select (($1::date + $2::time) at time zone $3) as t`, [date, hm, tz]);
  return rows[0]!.t;
}

/** Everything the planner board needs for one week (Monday → Sunday). */
export async function loadPlannerWeek(db: Queryable, deps: Deps, auth: AuthContext, weekStartInput: string): Promise<PlannerWeek> {
  const inst = await loadInstitution(db, auth.tenantId);
  const tz = inst.timezone;
  const weekStart = mondayOf(weekStartInput);
  const { today, now } = await localNow(db, tz, deps.clock());
  const from = await localToUtc(db, weekStart, '00:00', tz);
  const to = await localToUtc(db, addDaysYmd(weekStart, 7), '00:00', tz);

  // Sequential on purpose: `db` may be a transaction's single connection.
  const run = async <T extends unknown[]>(qs: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> => {
    const out: unknown[] = [];
    for (const q of qs) out.push(await q());
    return out as T;
  };
  const [sessions, courses, enrolled, cb, staff, rooms, batches, slots] = await run([
    () => db.query<{
      id: string;
      slot_id: string | null;
      course_id: string;
      status: PlannerItem['status'];
      mode: SessionMode;
      room_id: string | null;
      substitute_id: string | null;
      instructor_id: string | null;
      change_kind: string | null;
      date: string;
      start_hm: string;
      end_hm: string;
      end_date: string;
      scheduled_start: Date;
    }>(
      `select s.id, s.slot_id, s.course_id, s.status, s.mode, s.room_id, s.substitute_id, c.instructor_id, s.change_kind, s.scheduled_start,
              to_char(s.scheduled_start at time zone $2, 'YYYY-MM-DD') as date,
              to_char(s.scheduled_start at time zone $2, 'HH24:MI') as start_hm,
              to_char(s.scheduled_end at time zone $2, 'HH24:MI') as end_hm,
              to_char(s.scheduled_end at time zone $2, 'YYYY-MM-DD') as end_date
         from class_sessions s join courses c on c.id = s.course_id
        where s.tenant_id = $1 and s.scheduled_start >= $3 and s.scheduled_start < $4
        order by s.scheduled_start`,
      [auth.tenantId, tz, from, to],
    ),
    () => db.query<{ id: string; code: string; title: string; kind: 'theory' | 'lab'; default_mode: SessionMode; instructor_id: string | null; instructor_name: string | null; active: boolean }>(
      `select c.id, c.code, c.title, c.kind, c.default_mode, c.instructor_id, u.full_name as instructor_name, c.active
         from courses c left join users u on u.id = c.instructor_id where c.tenant_id = $1 order by c.code`,
      [auth.tenantId],
    ),
    () => db.query<{ course_id: string; user_id: string }>(
      `select e.course_id, e.user_id from enrollments e join courses c on c.id = e.course_id
         join users u on u.id = e.user_id and u.status = 'active' and u.role = 'student' where c.tenant_id = $1`,
      [auth.tenantId],
    ),
    () => db.query<{ course_id: string; batch_id: string }>(`select cb.course_id, cb.batch_id from course_batches cb join batches b on b.id = cb.batch_id where b.tenant_id = $1`, [auth.tenantId]),
    () => db.query<{ id: string; full_name: string; role: string }>(
      `select id, full_name, role from users where tenant_id = $1 and role in ('teacher', 'admin') and status = 'active' order by full_name`,
      [auth.tenantId],
    ),
    () => db.query<{ id: string; name: string }>(`select id, name from rooms where tenant_id = $1 and active order by name`, [auth.tenantId]),
    () => db.query<{ id: string; name: string; size: number }>(
      `select b.id, b.name, (select count(*)::int from batch_members m where m.batch_id = b.id) as size from batches b where b.tenant_id = $1 and b.active order by b.name`,
      [auth.tenantId],
    ),
    () => db.query<SlotRow>(`${SLOT_SELECT} where sl.tenant_id = $1 order by sl.weekday, sl.start_time`, [auth.tenantId]),
  ]);

  // Students become small numbers: enough to find clashes, nothing personal leaves the server.
  const index = new Map<string, number>();
  const studentsByCourse = new Map<string, number[]>();
  for (const r of enrolled.rows) {
    let n = index.get(r.user_id);
    if (n === undefined) index.set(r.user_id, (n = index.size));
    studentsByCourse.set(r.course_id, [...(studentsByCourse.get(r.course_id) ?? []), n]);
  }
  const batchesByCourse = new Map<string, string[]>();
  for (const r of cb.rows) batchesByCourse.set(r.course_id, [...(batchesByCourse.get(r.course_id) ?? []), r.batch_id]);
  const nowMs = deps.clock();

  return {
    weekStart,
    timezone: tz,
    today,
    now,
    items: sessions.rows.map((s) => ({
      key: s.id,
      sessionId: s.id,
      slotId: s.slot_id,
      courseId: s.course_id,
      date: s.date,
      start: s.start_hm,
      // A class never spans midnight on the board.
      end: s.end_date !== s.date || s.end_hm <= s.start_hm ? '23:59' : s.end_hm,
      roomId: s.room_id,
      teacherId: s.substitute_id ?? s.instructor_id,
      substitute: !!s.substitute_id,
      status: s.status,
      mode: s.mode,
      locked: s.status !== 'scheduled' || s.scheduled_start.getTime() <= nowMs,
      adjusted: !!s.change_kind,
      pending: [],
    })),
    slots: slots.rows.map(toSlot),
    courses: courses.rows.map(
      (c): PlannerCourse => ({
        id: c.id,
        code: c.code,
        title: c.title,
        kind: c.kind,
        defaultMode: c.default_mode,
        instructorId: c.instructor_id,
        instructorName: c.instructor_name,
        batchIds: batchesByCourse.get(c.id) ?? [],
        students: studentsByCourse.get(c.id) ?? [],
        active: c.active,
      }),
    ),
    teachers: staff.rows.map((t) => ({ id: t.id, name: t.full_name, role: t.role })),
    rooms: rooms.rows,
    batches: batches.rows,
  };
}

const conflictId = (c: PlannerConflict) => `${c.kind}|${[...c.keys].sort().join('|')}`;

/** Weekly-slot clashes: every active slot laid out on one abstract week. */
function slotConflicts(week: PlannerWeek, ops: DraftOp[]): PlannerConflict[] {
  const courses = new Map(week.courses.map((c) => [c.id, c]));
  const day = (w: number) => addDaysYmd('2001-01-01', (w + 6) % 7); // 2001-01-01 was a Monday
  const items = new Map<string, { key: string; courseId: string; date: string; start: string; end: string; roomId: string | null; teacherId: string | null; status: 'scheduled'; changed: boolean }>();
  for (const s of week.slots)
    if (s.active)
      items.set(s.id, { key: s.id, courseId: s.courseId, date: day(s.weekday), start: s.start, end: s.end, roomId: s.room?.id ?? null, teacherId: courses.get(s.courseId)?.instructorId ?? null, status: 'scheduled', changed: false });
  for (const o of ops) {
    if (o.op === 'slot.delete') items.delete(o.slotId);
    else if (o.op === 'slot.update') {
      const it = items.get(o.slotId);
      if (!it) continue;
      const courseId = o.courseId ?? it.courseId;
      Object.assign(it, { courseId, date: day(o.weekday), start: o.start, end: o.end, roomId: o.roomId === undefined ? it.roomId : o.roomId, teacherId: courses.get(courseId)?.instructorId ?? null, changed: true });
    } else if (o.op === 'slot.create')
      items.set(`new:${o.tempId}`, { key: `new:${o.tempId}`, courseId: o.courseId, date: day(o.weekday), start: o.start, end: o.end, roomId: o.roomId ?? null, teacherId: courses.get(o.courseId)?.instructorId ?? null, status: 'scheduled', changed: true });
  }
  const changed = new Set([...items.values()].filter((i) => i.changed).map((i) => i.key));
  const names = { teachers: new Map(week.teachers.map((t) => [t.id, t.name])), rooms: new Map(week.rooms.map((r) => [r.id, r.name])) };
  const baseItems = week.slots.filter((s) => s.active).map((s) => ({ key: s.id, courseId: s.courseId, date: day(s.weekday), start: s.start, end: s.end, roomId: s.room?.id ?? null, teacherId: courses.get(s.courseId)?.instructorId ?? null, status: 'scheduled' as const }));
  const before = new Set(findConflicts(baseItems, week.courses).map(conflictId));
  return findConflicts([...items.values()], week.courses, names)
    .filter((c) => (changed.has(c.keys[0]) || changed.has(c.keys[1])) && !before.has(conflictId(c)))
    .map((c) => ({ ...c, message: `Every ${WEEKDAY_NAMES[new Date(`${c.date}T00:00:00Z`).getUTCDay()]}: ${c.message.replace(/ \(2001-01-\d\d /, ' (')}` }));
}

interface PublishOpts {
  acceptWarnings?: boolean;
  note?: string | null;
  /** Only validate: never writes anything. */
  dryRun?: boolean;
}

export interface PublishResult extends PublishResponse {
  created: Record<string, string>;
}

/**
 * Validates and applies a list of timetable changes as one unit.
 * Must run inside a transaction (`tx`); weekly slots that changed are returned
 * so the caller can re-generate their classes after commit.
 */
export async function publishOps(
  tx: PoolClient,
  deps: Deps,
  auth: AuthContext,
  rawOps: unknown,
  opts: PublishOpts = {},
): Promise<PublishResult & { slotsToMaterialize: string[] }> {
  const ops = DraftOps.parse(rawOps);
  if (!ops.length) throw new ApiError(400, 'BAD_REQUEST', 'There are no changes to publish.');
  const admin = isAdmin(auth);
  const errors: OpError[] = [];

  // ── who may do what ──
  const sessionIds = new Set<string>();
  for (const [index, o] of ops.entries()) {
    if (o.op.startsWith('slot.') && !admin) {
      errors.push({ index, message: 'Only admins can change the weekly timetable.' });
      continue;
    }
    if ('sessionId' in o) {
      try {
        const s = await loadSessionFor(tx, auth, o.sessionId, true);
        if (!isOwnerOf(auth, s)) errors.push({ index, message: 'Only the course’s own teacher or an admin can change this class.' });
        if (o.op === 'cancel') {
          const marks = await tx.query('select 1 from attendance_records where session_id = $1 limit 1', [s.id]);
          if (marks.rowCount) errors.push({ index, message: 'This class already has attendance, so it can’t be cancelled.' });
        }
        sessionIds.add(o.sessionId);
      } catch {
        errors.push({ index, message: 'That class no longer exists.' });
      }
    }
    if (o.op === 'extra' || o.op === 'slot.create' || (o.op === 'slot.update' && o.courseId)) {
      try {
        await loadCourseFor(tx, auth, (o as { courseId: string }).courseId);
      } catch {
        errors.push({ index, message: 'Unknown course.' });
      }
    }
  }

  // ── validate with the shared engine, week by week ──
  const inst = await loadInstitution(tx, auth.tenantId);
  const { today } = await localNow(tx, inst.timezone, deps.clock());
  const weeks = new Set<string>([mondayOf(today)]);
  if (sessionIds.size) {
    const { rows } = await tx.query<{ d: string }>(
      `select distinct to_char(scheduled_start at time zone $2, 'YYYY-MM-DD') as d from class_sessions where id = any($1::uuid[])`,
      [[...sessionIds], inst.timezone],
    );
    for (const r of rows) weeks.add(mondayOf(r.d));
  }
  for (const o of ops) if ('date' in o) weeks.add(mondayOf(o.date));

  const conflicts: PlannerConflict[] = [];
  let firstWeek: PlannerWeek | null = null;
  for (const w of [...weeks].sort()) {
    const week = await loadPlannerWeek(tx, deps, auth, w);
    firstWeek ??= week;
    const res = applyOps(week, ops);
    // Session ops for classes in other weeks are validated in their own week.
    for (const e of res.errors) if (!errors.some((x) => x.index === e.index)) errors.push(e);
    const changed = new Set(res.items.filter((i) => i.pending.length).map((i) => i.key));
    const names = { teachers: new Map(week.teachers.map((t) => [t.id, t.name])), rooms: new Map(week.rooms.map((r) => [r.id, r.name])) };
    // Only clashes this change *introduces* count; ones that already existed don't block it.
    const before = new Set(findConflicts(week.items, week.courses).map(conflictId));
    for (const c of findConflicts(res.items, week.courses, names))
      if ((changed.has(c.keys[0]) || changed.has(c.keys[1])) && !before.has(conflictId(c))) conflicts.push(c);
  }
  if (ops.some((o) => o.op.startsWith('slot.')) && firstWeek) conflicts.push(...slotConflicts(firstWeek, ops));
  for (const o of ops)
    if ((o.op === 'substitute' || o.op === 'extra') && o.teacherId && !firstWeek?.teachers.some((t) => t.id === o.teacherId))
      errors.push({ index: ops.indexOf(o), message: 'That teacher isn’t an active staff member.' });
  for (const o of ops)
    if ('roomId' in o && o.roomId && !firstWeek?.rooms.some((r) => r.id === o.roomId)) errors.push({ index: ops.indexOf(o), message: 'That room doesn’t exist or is hidden.' });

  const blocked = errors.length > 0 || conflicts.some((c) => c.severity === 'error') || (conflicts.length > 0 && !opts.acceptWarnings);
  const empty = { applied: 0, notified: 0, created: {}, slotsToMaterialize: [] as string[] };
  if (blocked || opts.dryRun) return { published: false, conflicts, errors: errors.sort((a, b) => a.index - b.index), ...empty };

  // ── apply ──
  const tz = inst.timezone;
  const t = new Date(deps.clock());
  const lines: ChangeLine[] = [];
  const staffLines = new Map<string, ChangeLine[]>();
  const tellStaff = (userId: string | null | undefined, l: ChangeLine) => {
    if (userId && userId !== auth.userId) staffLines.set(userId, [...(staffLines.get(userId) ?? []), l]);
  };
  const created: Record<string, string> = {};
  const slotsToMaterialize: string[] = [];
  const courseInfo = async (id: string) =>
    (
      await tx.query<{ code: string; instructor_id: string | null }>('select code, instructor_id from courses where id = $1', [id])
    ).rows[0]!;
  const nameOf = async (userId: string | null) =>
    userId ? ((await tx.query<{ full_name: string }>('select full_name from users where id = $1', [userId])).rows[0]?.full_name ?? 'another teacher') : null;
  const roomOf = async (roomId: string | null | undefined) =>
    roomId ? ((await tx.query<{ id: string; name: string; lat: number | null; lng: number | null; radius_m: number }>('select id, name, lat, lng, radius_m from rooms where id = $1', [roomId])).rows[0] ?? null) : null;

  for (const o of ops) {
    switch (o.op) {
      case 'reschedule': {
        const s = (
          await tx.query<{ course_id: string; scheduled_start: Date; substitute_id: string | null; change_kind: string | null; room_id: string | null }>(
            'select course_id, scheduled_start, substitute_id, change_kind, room_id from class_sessions where id = $1 for update',
            [o.sessionId],
          )
        ).rows[0]!;
        const start = await localToUtc(tx, o.date, o.start, tz);
        const end = await localToUtc(tx, o.date, o.end, tz);
        const room = o.roomId === undefined ? undefined : await roomOf(o.roomId);
        await tx.query(
          `update class_sessions set original_start = coalesce(original_start, scheduled_start), scheduled_start = $2, scheduled_end = $3,
                  room_id = case when $4 then $5 else room_id end, room = case when $4 then $6 else room end,
                  lat = case when $4 then $7 else lat end, lng = case when $4 then $8 else lng end, radius_m = case when $4 then coalesce($9, radius_m) else radius_m end,
                  change_kind = case when change_kind = 'extra' then 'extra' else 'rescheduled' end, change_note = coalesce($10, change_note), changed_at = $11, changed_by = $12
            where id = $1`,
          [o.sessionId, start, end, o.roomId !== undefined, room?.id ?? null, room?.name ?? null, room?.lat ?? null, room?.lng ?? null, room?.radius_m ?? null, opts.note ?? null, t, auth.userId],
        );
        const c = await courseInfo(s.course_id);
        const l: ChangeLine = { kind: 'rescheduled', courseId: s.course_id, courseCode: c.code, sessionId: o.sessionId, text: `${c.code} moved: ${fmtWhen(s.scheduled_start, tz)} → ${fmtWhen(start, tz)}${room ? ` · ${room.name}` : ''}` };
        lines.push(l);
        tellStaff(s.substitute_id ?? c.instructor_id, l);
        break;
      }
      case 'cancel': {
        const s = (await tx.query<{ course_id: string; scheduled_start: Date; substitute_id: string | null }>('select course_id, scheduled_start, substitute_id from class_sessions where id = $1', [o.sessionId])).rows[0]!;
        await tx.query(`update class_sessions set status = 'cancelled', change_kind = 'cancelled', change_note = $2, changed_at = $3, changed_by = $4 where id = $1`, [o.sessionId, o.reason, t, auth.userId]);
        const c = await courseInfo(s.course_id);
        const l: ChangeLine = { kind: 'cancelled', courseId: s.course_id, courseCode: c.code, sessionId: o.sessionId, text: `${c.code} on ${fmtWhen(s.scheduled_start, tz)} is cancelled — ${o.reason}` };
        lines.push(l);
        tellStaff(s.substitute_id ?? c.instructor_id, l);
        break;
      }
      case 'substitute': {
        const s = (await tx.query<{ course_id: string; scheduled_start: Date; substitute_id: string | null; change_kind: string | null }>('select course_id, scheduled_start, substitute_id, change_kind from class_sessions where id = $1', [o.sessionId])).rows[0]!;
        const c = await courseInfo(s.course_id);
        const next = o.teacherId && o.teacherId !== c.instructor_id ? o.teacherId : null;
        await tx.query(
          `update class_sessions set substitute_id = $2,
                  change_kind = case when change_kind is null and $2::uuid is not null then 'substitute' when change_kind = 'substitute' and $2::uuid is null then null else change_kind end,
                  changed_at = $3, changed_by = $4 where id = $1`,
          [o.sessionId, next, t, auth.userId],
        );
        const who = (await nameOf(next ?? c.instructor_id)) ?? 'the usual teacher';
        const l: ChangeLine = { kind: 'substitute', courseId: s.course_id, courseCode: c.code, sessionId: o.sessionId, text: `${c.code} on ${fmtWhen(s.scheduled_start, tz)} will be taken by ${who}` };
        lines.push(l);
        tellStaff(next, { ...l, text: `You’re taking ${c.code} on ${fmtWhen(s.scheduled_start, tz)} (adjustment)` });
        tellStaff(s.substitute_id, l);
        tellStaff(c.instructor_id, l);
        break;
      }
      case 'extra': {
        const c = await courseInfo(o.courseId);
        const room = await roomOf(o.roomId);
        const start = await localToUtc(tx, o.date, o.start, tz);
        const end = await localToUtc(tx, o.date, o.end, tz);
        const sub = o.teacherId && o.teacherId !== c.instructor_id ? o.teacherId : null;
        const course = (await tx.query<{ default_mode: SessionMode }>('select default_mode from courses where id = $1', [o.courseId])).rows[0]!;
        const s = await createSession(tx, {
          tenantId: auth.tenantId,
          courseId: o.courseId,
          room: room?.name ?? null,
          lat: room?.lat ?? null,
          lng: room?.lng ?? null,
          radiusM: room?.radius_m ?? 50,
          rotationS: 7,
          status: 'scheduled',
          scheduledStart: start,
          scheduledEnd: end,
          startedAt: null,
          createdBy: auth.userId,
          mode: o.mode ?? course.default_mode,
          roomId: room?.id ?? null,
          substituteId: sub,
          changeKind: 'extra',
          changeNote: opts.note ?? null,
          changedAt: t,
        });
        created[o.tempId] = s.id;
        const l: ChangeLine = { kind: 'extra', courseId: o.courseId, courseCode: c.code, sessionId: s.id, text: `Extra ${c.code} class: ${fmtWhen(start, tz)}${room ? ` · ${room.name}` : ''}` };
        lines.push(l);
        tellStaff(sub ?? c.instructor_id, l);
        break;
      }
      case 'slot.update': {
        const before = (await tx.query<SlotRow>(`${SLOT_SELECT} where sl.id = $1 and sl.tenant_id = $2`, [o.slotId, auth.tenantId])).rows[0]!;
        const room = o.roomId === undefined ? undefined : await roomOf(o.roomId);
        await tx.query(
          `update timetable_slots set weekday = $2, start_time = $3, end_time = $4, room_id = case when $5 then $6 else room_id end,
                  course_id = coalesce($7, course_id), updated_at = now() where id = $1`,
          [o.slotId, o.weekday, o.start, o.end, o.roomId !== undefined, room?.id ?? null, o.courseId ?? null],
        );
        await clearFutureOccurrences(tx, o.slotId, t);
        slotsToMaterialize.push(o.slotId);
        const courseId = o.courseId ?? before.course_id;
        const c = await courseInfo(courseId);
        const l: ChangeLine = {
          kind: 'weekly',
          courseId,
          courseCode: c.code,
          text: `${c.code} weekly class: every ${WEEKDAY_NAMES[before.weekday]} ${before.start_time} → every ${WEEKDAY_NAMES[o.weekday]} ${o.start}${room ? ` · ${room.name}` : ''}`,
        };
        lines.push(l);
        if (courseId !== before.course_id) lines.push({ ...l, courseId: before.course_id, courseCode: before.course_code, text: `${before.course_code}’s ${WEEKDAY_NAMES[before.weekday]} ${before.start_time} class is replaced by ${c.code}` });
        tellStaff(c.instructor_id, l);
        break;
      }
      case 'slot.create': {
        const room = await roomOf(o.roomId);
        const course = (await tx.query<{ default_mode: SessionMode }>('select default_mode from courses where id = $1', [o.courseId])).rows[0]!;
        const { rows } = await tx.query<{ id: string }>(
          `insert into timetable_slots(tenant_id, course_id, weekday, start_time, end_time, room_id, mode, rotation_s, valid_from, active, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, 7, $8::date, true, $9) returning id`,
          [auth.tenantId, o.courseId, o.weekday, o.start, o.end, room?.id ?? null, o.mode ?? course.default_mode, today, auth.userId],
        );
        created[o.tempId] = rows[0]!.id;
        slotsToMaterialize.push(rows[0]!.id);
        const c = await courseInfo(o.courseId);
        const l: ChangeLine = { kind: 'weekly', courseId: o.courseId, courseCode: c.code, text: `New weekly ${c.code} class: every ${WEEKDAY_NAMES[o.weekday]} ${o.start}${room ? ` · ${room.name}` : ''}` };
        lines.push(l);
        tellStaff(c.instructor_id, l);
        break;
      }
      case 'slot.delete': {
        const before = (await tx.query<SlotRow>(`${SLOT_SELECT} where sl.id = $1 and sl.tenant_id = $2`, [o.slotId, auth.tenantId])).rows[0]!;
        await clearFutureOccurrences(tx, o.slotId, t);
        await tx.query('delete from timetable_slots where id = $1', [o.slotId]);
        const c = await courseInfo(before.course_id);
        const l: ChangeLine = { kind: 'weekly', courseId: before.course_id, courseCode: c.code, text: `${c.code}’s ${WEEKDAY_NAMES[before.weekday]} ${before.start_time} class is removed from the timetable` };
        lines.push(l);
        tellStaff(c.instructor_id, l);
        break;
      }
    }
  }

  const notified = await deliverChanges(tx, auth.tenantId, lines, staffLines);
  await staffAudit(tx, auth, 'timetable.publish', `tenant:${auth.tenantId}`, {
    ops: ops.map((o) => o.op),
    sessions: [...sessionIds],
    created: Object.values(created),
    notified,
    warningsAccepted: conflicts.length,
  });
  return { published: true, applied: ops.length, notified, conflicts, errors: [], created, slotsToMaterialize };
}
