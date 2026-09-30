/**
 * Institute app — courses, enrollments, weekly timetable and reports.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CourseBody,
  EnrollmentBody,
  SlotBody,
  attendancePercent,
  sessionsNeededToReach,
  standing,
  type CourseReport,
  type CourseSummary,
  type RosterEntry,
  type Slot,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { COURSE_SELECT, STAFF, instructorFilter, loadCourseFor, requirePerm, type CourseRow } from '../lib/access';
import { requireDevice } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { loadTenantTerm } from '../lib/stats';
import { clearFutureOccurrences, materializeTimetable } from '../lib/timetable';
import { WEEKDAY_NAMES, deliverChanges } from '../lib/notify';
import { conflictMessage, staffAudit } from './staff-admin';

const IdParam = z.object({ id: z.uuid() });
const UNREACHABLE = 10_000;

export function toCourseSummary(c: CourseRow): CourseSummary {
  return {
    id: c.id,
    code: c.code,
    title: c.title,
    kind: c.kind,
    defaultMode: c.default_mode,
    instructor: c.instructor_id && c.instructor_name ? { id: c.instructor_id, name: c.instructor_name } : null,
    studentCount: c.student_count,
    active: c.active,
  };
}

export async function loadRoster(db: Queryable, courseId: string): Promise<RosterEntry[]> {
  const { rows } = await db.query<{ id: string; full_name: string; roll_no: string | null }>(
    `select u.id, u.full_name, u.roll_no from enrollments e join users u on u.id = e.user_id
      where e.course_id = $1 and u.status = 'active' and u.role = 'student' order by u.roll_no nulls last, u.full_name`,
    [courseId],
  );
  return rows.map((r) => ({ userId: r.id, fullName: r.full_name, rollNo: r.roll_no }));
}

export interface SlotRow {
  id: string;
  course_id: string;
  course_code: string;
  course_title: string;
  instructor: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
  room_id: string | null;
  room_name: string | null;
  mode: 'qr' | 'manual';
  rotation_s: number;
  scan_rounds: number;
  valid_from: string;
  valid_until: string | null;
  active: boolean;
}

export const SLOT_SELECT = `
  select sl.id, sl.course_id, c.code as course_code, c.title as course_title, i.full_name as instructor, sl.weekday,
         to_char(sl.start_time, 'HH24:MI') as start_time, to_char(sl.end_time, 'HH24:MI') as end_time,
         sl.room_id, r.name as room_name, sl.mode, sl.rotation_s, sl.scan_rounds,
         to_char(sl.valid_from, 'YYYY-MM-DD') as valid_from, to_char(sl.valid_until, 'YYYY-MM-DD') as valid_until, sl.active
    from timetable_slots sl join courses c on c.id = sl.course_id
    left join users i on i.id = c.instructor_id left join rooms r on r.id = sl.room_id`;

export const toSlot = (r: SlotRow): Slot => ({
  id: r.id,
  courseId: r.course_id,
  courseCode: r.course_code,
  courseTitle: r.course_title,
  instructor: r.instructor,
  weekday: r.weekday,
  start: r.start_time,
  end: r.end_time,
  room: r.room_id && r.room_name ? { id: r.room_id, name: r.room_name } : null,
  mode: r.mode,
  rotationS: r.rotation_s,
  scanRounds: r.scan_rounds,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
  active: r.active,
});

export async function staffAcademicRoutes(app: FastifyInstance, deps: Deps) {
  const now = () => new Date(deps.clock());

  // ── courses ──
  app.get('/v1/staff/courses', async (req): Promise<CourseSummary[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    // scope=all: every subject of the institution (read-only list, e.g. to add one to a batch).
    const q = z.object({ scope: z.enum(['mine', 'all']).default('mine') }).parse(req.query);
    const { rows } = await deps.db.query<CourseRow>(
      `${COURSE_SELECT} where c.tenant_id = $1 and ($2::uuid is null or c.instructor_id = $2) order by c.active desc, c.code`,
      [auth.tenantId, q.scope === 'all' ? null : instructorFilter(auth)],
    );
    return rows.map(toCourseSummary);
  });

  async function checkInstructor(db: Queryable, tenantId: string, instructorId: string | null | undefined) {
    if (!instructorId) return;
    const r = await db.query(`select 1 from users where id = $1 and tenant_id = $2 and role in ('teacher', 'admin') and status = 'active'`, [instructorId, tenantId]);
    if (r.rowCount !== 1) throw new ApiError(400, 'BAD_REQUEST', 'The instructor must be an active teacher or admin of this institution.');
  }

  app.post('/v1/staff/courses', async (req): Promise<CourseSummary> => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'courses');
    const b = CourseBody.parse(req.body);
    await checkInstructor(deps.db, auth.tenantId, b.instructorId);
    try {
      const id = await withTx(deps.db, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `insert into courses(tenant_id, code, title, kind, default_mode, instructor_id, active) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [auth.tenantId, b.code, b.title, b.kind, b.defaultMode, b.instructorId ?? null, b.active],
        );
        await staffAudit(tx, auth, 'course.create', `course:${rows[0]!.id}`, { code: b.code });
        return rows[0]!.id;
      });
      return toCourseSummary(await loadCourseFor(deps.db, auth, id));
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'courses_tenant_id_code_key') throw new ApiError(409, 'CONFLICT', 'A course with that code already exists.');
      throw err;
    }
  });

  app.post('/v1/staff/courses/:id', async (req): Promise<CourseSummary> => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'courses');
    const { id } = IdParam.parse(req.params);
    const b = CourseBody.parse(req.body);
    await loadCourseFor(deps.db, auth, id);
    await checkInstructor(deps.db, auth.tenantId, b.instructorId);
    try {
      await withTx(deps.db, async (tx) => {
        await tx.query(`update courses set code = $2, title = $3, kind = $4, default_mode = $5, instructor_id = $6, active = $7 where id = $1`, [
          id,
          b.code,
          b.title,
          b.kind,
          b.defaultMode,
          b.instructorId ?? null,
          b.active,
        ]);
        if (!b.active) {
          // Retiring a course removes its future, unused classes.
          await tx.query(
            `delete from class_sessions s where s.course_id = $1 and s.status = 'scheduled' and s.scheduled_start > $2
               and not exists (select 1 from attendance_records a where a.session_id = s.id)`,
            [id, now()],
          );
        }
        await staffAudit(tx, auth, 'course.update', `course:${id}`, { code: b.code, active: b.active });
      });
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'courses_tenant_id_code_key') throw new ApiError(409, 'CONFLICT', 'A course with that code already exists.');
      throw err;
    }
    if (b.active) await materializeTimetable(deps.db, { tenantId: auth.tenantId });
    return toCourseSummary(await loadCourseFor(deps.db, auth, id));
  });

  app.get('/v1/staff/courses/:id/roster', async (req): Promise<RosterEntry[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    await loadCourseFor(deps.db, auth, id);
    return loadRoster(deps.db, id);
  });

  app.post('/v1/staff/courses/:id/enrollments', async (req): Promise<RosterEntry[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'courses');
    const { id } = IdParam.parse(req.params);
    const b = EnrollmentBody.parse(req.body);
    await loadCourseFor(deps.db, auth, id);
    await withTx(deps.db, async (tx) => {
      if (b.add.length) {
        const ok = await tx.query(`select id from users where tenant_id = $1 and role = 'student' and id = any($2::uuid[])`, [auth.tenantId, b.add]);
        if (ok.rowCount !== new Set(b.add).size) throw new ApiError(400, 'BAD_REQUEST', 'Only students of this institution can be enrolled.');
        for (const u of new Set(b.add)) await tx.query('insert into enrollments(course_id, user_id) values ($1, $2) on conflict do nothing', [id, u]);
      }
      if (b.remove.length) {
        const viaBatch = await tx.query<{ name: string; n: number }>(
          `select b.name, count(*)::int as n from enrollments e join batches b on b.id = e.batch_id
            where e.course_id = $1 and e.user_id = any($2::uuid[]) group by b.name`,
          [id, b.remove],
        );
        if (viaBatch.rows.length)
          throw new ApiError(
            409,
            'CONFLICT',
            `${viaBatch.rows.map((r) => `${r.n} from batch ${r.name}`).join(', ')} are in this course through their batch. Remove them from the batch, or detach the batch from the course.`,
          );
        await tx.query('delete from enrollments where course_id = $1 and user_id = any($2::uuid[])', [id, b.remove]);
      }
      await staffAudit(tx, auth, 'course.enrollments', `course:${id}`, { added: b.add.length, removed: b.remove.length });
    });
    return loadRoster(deps.db, id);
  });

  app.get('/v1/staff/courses/:id/report', async (req): Promise<CourseReport> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const course = await loadCourseFor(deps.db, auth, id);
    const term = await loadTenantTerm(deps.db, auth.tenantId);
    const held = await deps.db.query<{ n: number }>(
      `select count(*) as n from class_sessions s
        where s.course_id = $1 and s.status in ('live', 'closed') and s.started_at >= ($2::date::timestamp at time zone $3)`,
      [id, term.term_start, term.timezone],
    );
    const { rows } = await deps.db.query<{ id: string; full_name: string; roll_no: string | null; attended: number; held: number }>(
      `select u.id, u.full_name, u.roll_no,
              count(a.id) as attended,
              count(s.id) filter (where s.status = 'closed' or a.id is not null) as held
         from enrollments e
         join users u on u.id = e.user_id and u.role = 'student'
         left join class_sessions s on s.course_id = e.course_id and s.status in ('live', 'closed') and s.started_at >= ($2::date::timestamp at time zone $3)
         left join attendance_records a on a.session_id = s.id and a.user_id = u.id and a.revoked_at is null
        where e.course_id = $1
        group by u.id order by u.roll_no nulls last, u.full_name`,
      [id, term.term_start, term.timezone],
    );
    const min = term.min_attendance;
    return {
      course: toCourseSummary(course),
      minPercent: min,
      held: held.rows[0]!.n,
      students: rows.map((r) => ({
        userId: r.id,
        fullName: r.full_name,
        rollNo: r.roll_no,
        attended: r.attended,
        held: r.held,
        percent: attendancePercent(r.attended, r.held),
        standing: standing(r.attended, r.held, min),
        needToReach: Math.min(sessionsNeededToReach(r.attended, r.held, min), UNREACHABLE),
      })),
    };
  });

  // ── weekly timetable ──
  app.get('/v1/staff/timetable', async (req): Promise<Slot[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { rows } = await deps.db.query<SlotRow>(
      `${SLOT_SELECT} where sl.tenant_id = $1 and ($2::uuid is null or c.instructor_id = $2) order by sl.active desc, sl.weekday, sl.start_time`,
      [auth.tenantId, instructorFilter(auth)],
    );
    return rows.map(toSlot);
  });

  async function saveSlot(req: FastifyRequest, id: string | null): Promise<Slot> {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'courses');
    const b = SlotBody.parse(req.body);
    await loadCourseFor(deps.db, auth, b.courseId);
    if (b.roomId) {
      const r = await deps.db.query('select 1 from rooms where id = $1 and tenant_id = $2', [b.roomId, auth.tenantId]);
      if (r.rowCount !== 1) throw new ApiError(400, 'BAD_REQUEST', 'Unknown room.');
    }
    // No double-booking the same room at overlapping times on the same weekday.
    if (b.roomId && b.active) {
      const clash = await deps.db.query<{ code: string }>(
        `select c.code from timetable_slots sl join courses c on c.id = sl.course_id
          where sl.tenant_id = $1 and sl.active and sl.room_id = $2 and sl.weekday = $3 and ($4::uuid is null or sl.id <> $4)
            and sl.start_time < $6::time and sl.end_time > $5::time
            and (sl.valid_until is null or sl.valid_until >= coalesce($7::date, current_date))
          limit 1`,
        [auth.tenantId, b.roomId, b.weekday, id, b.start, b.end, b.validFrom ?? null],
      );
      if (clash.rows[0]) throw new ApiError(409, 'CONFLICT', `That room is already booked for ${clash.rows[0].code} at an overlapping time.`);
    }
    // …and no teacher in two places at once.
    if (b.active) {
      const busy = await deps.db.query<{ code: string }>(
        `select c.code from timetable_slots sl join courses c on c.id = sl.course_id
          where sl.tenant_id = $1 and sl.active and sl.weekday = $3 and ($4::uuid is null or sl.id <> $4)
            and sl.start_time < $6::time and sl.end_time > $5::time
            and (sl.valid_until is null or sl.valid_until >= coalesce($7::date, current_date))
            and c.instructor_id is not null and c.instructor_id = (select instructor_id from courses where id = $2)
          limit 1`,
        [auth.tenantId, b.courseId, b.weekday, id, b.start, b.end, b.validFrom ?? null],
      );
      if (busy.rows[0]) throw new ApiError(409, 'CONFLICT', `This course’s teacher already teaches ${busy.rows[0].code} at an overlapping time that day.`);
    }
    const slotId = await withTx(deps.db, async (tx) => {
      const before = id ? (await tx.query<SlotRow>(`${SLOT_SELECT} where sl.id = $1 and sl.tenant_id = $2`, [id, auth.tenantId])).rows[0] : undefined;
      const params = [auth.tenantId, b.courseId, b.weekday, b.start, b.end, b.roomId ?? null, b.mode, b.rotationS, b.validFrom ?? null, b.validUntil ?? null, b.active, b.mode === 'qr' ? b.scanRounds : 1];
      const { rows } = id
        ? await tx.query<{ id: string }>(
            `update timetable_slots set course_id = $2, weekday = $3, start_time = $4, end_time = $5, room_id = $6, mode = $7, rotation_s = $8,
                    valid_from = coalesce($9::date, valid_from), valid_until = $10::date, active = $11, scan_rounds = $12, updated_at = now()
              where id = $13 and tenant_id = $1 returning id`,
            [...params, id],
          )
        : await tx.query<{ id: string }>(
            `insert into timetable_slots(tenant_id, course_id, weekday, start_time, end_time, room_id, mode, rotation_s, valid_from, valid_until, active, scan_rounds, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::date, current_date), $10::date, $11, $12, $13) returning id`,
            [...params, auth.userId],
          );
      if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Timetable entry not found.');
      if (id) await clearFutureOccurrences(tx, id, now());
      // Tell the students (and the teacher) what changed in their week.
      const course = await loadCourseFor(tx, auth, b.courseId);
      const roomName = b.roomId ? ((await tx.query<{ name: string }>('select name from rooms where id = $1', [b.roomId])).rows[0]?.name ?? null) : null;
      const at = `every ${WEEKDAY_NAMES[b.weekday]} ${b.start}${roomName ? ` · ${roomName}` : ''}`;
      let text: string | null = null;
      if (!before) text = b.active ? `New weekly ${course.code} class: ${at}` : null;
      else if (before.active && !b.active) text = `${course.code}’s ${WEEKDAY_NAMES[before.weekday]} ${before.start_time} class is paused`;
      else if (!before.active && b.active) text = `${course.code} weekly class is back: ${at}`;
      else if (before.weekday !== b.weekday || before.start_time !== b.start || before.end_time !== b.end || before.room_id !== (b.roomId ?? null) || before.course_id !== b.courseId)
        text = `${course.code} weekly class: every ${WEEKDAY_NAMES[before.weekday]} ${before.start_time} → ${at}`;
      if (text) {
        const line = { kind: 'weekly' as const, courseId: b.courseId, courseCode: course.code, text };
        const staff = course.instructor_id ? new Map([[course.instructor_id, [line]]]) : undefined;
        await deliverChanges(tx, auth.tenantId, [line], staff, { skipUserId: auth.userId });
      }
      await staffAudit(tx, auth, id ? 'timetable.update' : 'timetable.create', `slot:${rows[0].id}`, {
        course: b.courseId,
        weekday: b.weekday,
        start: b.start,
        end: b.end,
        active: b.active,
      });
      return rows[0].id;
    });
    await materializeTimetable(deps.db, { slotId });
    const { rows } = await deps.db.query<SlotRow>(`${SLOT_SELECT} where sl.id = $1`, [slotId]);
    return toSlot(rows[0]!);
  }

  app.post('/v1/staff/timetable', async (req) => {
    try {
      return await saveSlot(req, null);
    } catch (err) {
      const msg = conflictMessage(err);
      if (msg && !(err instanceof ApiError)) throw new ApiError(409, 'CONFLICT', msg);
      throw err;
    }
  });
  app.post('/v1/staff/timetable/:id', async (req) => saveSlot(req, IdParam.parse(req.params).id));

  app.post('/v1/staff/timetable/:id/delete', async (req) => {
    const auth = await requireDevice(req, deps, STAFF);
    requirePerm(auth, 'courses');
    const { id } = IdParam.parse(req.params);
    await withTx(deps.db, async (tx) => {
      const r = await tx.query('select 1 from timetable_slots where id = $1 and tenant_id = $2', [id, auth.tenantId]);
      if (r.rowCount !== 1) throw new ApiError(404, 'NOT_FOUND', 'Timetable entry not found.');
      await clearFutureOccurrences(tx, id, now());
      const before = (await tx.query<SlotRow>(`${SLOT_SELECT} where sl.id = $1`, [id])).rows[0]!;
      if (before.active)
        await deliverChanges(tx, auth.tenantId, [
          { kind: 'weekly', courseId: before.course_id, courseCode: before.course_code, text: `${before.course_code}’s ${WEEKDAY_NAMES[before.weekday]} ${before.start_time} class is removed from the timetable` },
        ]);
      // Past classes keep their history; the slot link is cleared by the FK.
      await tx.query('delete from timetable_slots where id = $1', [id]);
      await staffAudit(tx, auth, 'timetable.delete', `slot:${id}`);
    });
    return { ok: true as const };
  });
}
