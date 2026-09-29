import { attendancePercent, standing, type AttendanceAnalytics, type MatrixReport, type PunctualityReport, type StudentTrend, type PunctualityStatus, type ReportHeader, type StudentReport } from '@attendly/protocol';
import type { Queryable } from '../db';
import { ApiError } from './errors';
import { courseStats, loadTenantTerm, type TenantTerm } from './stats';

async function header(db: Queryable, tenantId: string, now: number): Promise<{ h: ReportHeader; term: TenantTerm }> {
  const term = await loadTenantTerm(db, tenantId);
  const t = await db.query<{ name: string }>('select name from tenants where id = $1', [tenantId]);
  return {
    term,
    h: { institution: t.rows[0]?.name ?? '', termName: term.term_name, minPercent: term.min_attendance, timezone: term.timezone, generatedAt: new Date(now).toISOString() },
  };
}

const HOW: Record<string, string> = { scan: 'QR scan', manual: 'Register', import: 'Imported', review: 'Approved by teacher', credit: 'Attendance credit' };

/** One student's attendance, every subject; with `courseId`, that subject plus its class-by-class log. */
export async function buildStudentReport(db: Queryable, tenantId: string, userId: string, now: number, courseId?: string): Promise<StudentReport> {
  const u = await db.query<{ id: string; full_name: string; roll_no: string | null }>(
    `select id, full_name, roll_no from users where id = $1 and tenant_id = $2 and role = 'student'`,
    [userId, tenantId],
  );
  const student = u.rows[0];
  if (!student) throw new ApiError(404, 'NOT_FOUND', 'Student not found.');
  const { h, term } = await header(db, tenantId, now);
  const stats = await courseStats(db, userId, term, courseId);
  if (courseId && !stats.length) throw new ApiError(404, 'NOT_FOUND', 'This student isn’t in that subject.');
  const batches = await db.query<{ name: string }>(
    'select b.name from batch_members m join batches b on b.id = m.batch_id where m.user_id = $1 order by b.name',
    [userId],
  );
  const min = term.min_attendance;
  const attended = stats.reduce((n, s) => n + s.attended, 0);
  const held = stats.reduce((n, s) => n + s.held, 0);

  let classes: StudentReport['classes'] = null;
  if (courseId) {
    const { rows } = await db.query<{ id: string; code: string; started_at: Date; status: string; source: string | null }>(
      `select s.id, c.code, s.started_at, s.status, a.source
         from class_sessions s join courses c on c.id = s.course_id
         left join attendance_records a on a.session_id = s.id and a.user_id = $2 and a.revoked_at is null
        where s.course_id = $1 and s.status in ('live', 'closed') and s.started_at >= ($3::date::timestamp at time zone $4)
        order by s.started_at`,
      [courseId, userId, term.term_start, term.timezone],
    );
    classes = rows.map((r) => ({
      sessionId: r.id,
      courseCode: r.code,
      start: r.started_at.toISOString(),
      status: r.source ? 'present' : r.status === 'live' ? 'live' : 'absent',
      how: r.source ? (HOW[r.source] ?? r.source) : null,
    }));
  }

  return {
    ...h,
    student: { userId: student.id, fullName: student.full_name, rollNo: student.roll_no, batches: batches.rows.map((b) => b.name) },
    subjects: stats.map((s) => ({
      courseId: s.course_id,
      code: s.code,
      title: s.title,
      instructor: s.instructor,
      attended: s.attended,
      held: s.held,
      percent: attendancePercent(s.attended, s.held),
      standing: standing(s.attended, s.held, min),
    })),
    total: { attended, held, percent: attendancePercent(attended, held), standing: standing(attended, held, min) },
    classes,
  };
}

/** Students × subjects for a batch, a subject, both, or (neither) the whole institution. */
export async function buildMatrixReport(db: Queryable, tenantId: string, now: number, q: { batchId?: string; courseId?: string }): Promise<MatrixReport> {
  const { h, term } = await header(db, tenantId, now);
  let batchName: string | null = null;
  if (q.batchId) {
    const b = await db.query<{ name: string }>('select name from batches where id = $1 and tenant_id = $2', [q.batchId, tenantId]);
    if (!b.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Batch not found.');
    batchName = b.rows[0].name;
  }
  let courseLabel: string | null = null;
  if (q.courseId) {
    const c = await db.query<{ code: string; title: string }>('select code, title from courses where id = $1 and tenant_id = $2', [q.courseId, tenantId]);
    if (!c.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Subject not found.');
    courseLabel = c.rows[0].code === c.rows[0].title ? c.rows[0].code : `${c.rows[0].code} · ${c.rows[0].title}`;
  }
  const params = [tenantId, term.term_start, term.timezone, q.batchId ?? null, q.courseId ?? null];
  // Placeholders differ between the two queries (Postgres rejects unused parameters).
  const scoped = (b: string, c: string) => `
    select u.id, u.full_name, u.roll_no from users u
     where u.tenant_id = $1 and u.role = 'student' and u.status = 'active'
       and (${b}::uuid is null or exists (select 1 from batch_members m where m.user_id = u.id and m.batch_id = ${b}))
       and (${c}::uuid is null or exists (select 1 from enrollments e where e.user_id = u.id and e.course_id = ${c}))`;
  const [students, cells] = await Promise.all([
    db.query<{ id: string; full_name: string; roll_no: string | null }>(`${scoped('$2', '$3')} order by u.roll_no nulls last, u.full_name limit 3000`, [tenantId, q.batchId ?? null, q.courseId ?? null]),
    db.query<{ user_id: string; course_id: string; code: string; title: string; instructor: string | null; attended: number; held: number }>(
      `with st as (${scoped('$4', '$5')}), bounds as (select ($2::date::timestamp at time zone $3) as ts)
       select e.user_id, c.id as course_id, c.code, c.title, i.full_name as instructor,
              count(a.id) as attended,
              count(s.id) filter (where s.status = 'closed' or a.id is not null) as held
         from enrollments e
         join st on st.id = e.user_id
         join courses c on c.id = e.course_id and c.tenant_id = $1
         left join users i on i.id = c.instructor_id
         cross join bounds b
         left join class_sessions s on s.course_id = c.id and s.status in ('live', 'closed') and s.started_at >= b.ts
         left join attendance_records a on a.session_id = s.id and a.user_id = e.user_id and a.revoked_at is null
        where ($5::uuid is null or c.id = $5)
        group by e.user_id, c.id, c.code, c.title, i.full_name`,
      params,
    ),
  ]);

  const courses = new Map<string, MatrixReport['courses'][number]>();
  for (const r of cells.rows) if (!courses.has(r.course_id)) courses.set(r.course_id, { courseId: r.course_id, code: r.code, title: r.title, instructor: r.instructor });
  const courseList = [...courses.values()].sort((a, b) => a.code.localeCompare(b.code));
  const col = new Map(courseList.map((c, i) => [c.courseId, i]));
  const byUser = new Map<string, MatrixReport['students'][number]['cells']>();
  for (const r of cells.rows) {
    const row = byUser.get(r.user_id) ?? courseList.map(() => null);
    row[col.get(r.course_id)!] = { attended: r.attended, held: r.held };
    byUser.set(r.user_id, row);
  }
  const min = term.min_attendance;
  return {
    ...h,
    scope: {
      batchId: q.batchId ?? null,
      batchName,
      courseId: q.courseId ?? null,
      label: [batchName, courseLabel].filter(Boolean).join(' · ') || 'All students',
    },
    courses: courseList,
    students: students.rows.map((s) => {
      const row = byUser.get(s.id) ?? courseList.map(() => null);
      const attended = row.reduce((n, c) => n + (c?.attended ?? 0), 0);
      const held = row.reduce((n, c) => n + (c?.held ?? 0), 0);
      return { userId: s.id, fullName: s.full_name, rollNo: s.roll_no, cells: row, attended, held, percent: attendancePercent(attended, held), standing: standing(attended, held, min) };
    }),
  };
}

/**
 * How professors are doing: every class of the period whose time has come — started on time,
 * late (from 2 minutes; by how much), never started ("not held") or cancelled. The professor of a
 * class is its substitute when someone covered it. `teacherId` limits it to one professor.
 */
export async function buildPunctualityReport(db: Queryable, tenantId: string, now: number, q: { days: number; teacherId?: string }): Promise<PunctualityReport> {
  const { h } = await header(db, tenantId, now);
  const to = new Date(now);
  const from = new Date(now - q.days * 86_400_000);
  const { rows } = await db.query<{
    id: string;
    teacher_id: string | null;
    teacher: string | null;
    code: string;
    title: string;
    room: string | null;
    scheduled_start: Date;
    scheduled_end: Date;
    started_at: Date | null;
    ended_at: Date | null;
    status: string;
    missed_at: Date | null;
    substitute: boolean;
  }>(
    `select s.id, coalesce(s.substitute_id, c.instructor_id) as teacher_id, t.full_name as teacher, c.code, c.title, coalesce(r.name, s.room) as room,
            s.scheduled_start, s.scheduled_end, s.started_at, s.ended_at, s.status, s.missed_at, s.substitute_id is not null as substitute
       from class_sessions s
       join courses c on c.id = s.course_id
       left join users t on t.id = coalesce(s.substitute_id, c.instructor_id)
       left join rooms r on r.id = s.room_id
      where s.tenant_id = $1 and s.scheduled_start >= $2 and s.scheduled_start <= $3
        and ($4::uuid is null or coalesce(s.substitute_id, c.instructor_id) = $4)
      order by s.scheduled_start desc
      limit 5000`,
    [tenantId, from, to, q.teacherId ?? null],
  );
  const classes: PunctualityReport['classes'] = [];
  for (const r of rows) {
    let status: PunctualityStatus;
    let lateMin: number | null = null;
    if (r.status === 'cancelled') status = 'cancelled';
    else if (r.started_at) {
      const late = Math.floor((r.started_at.getTime() - r.scheduled_start.getTime()) / 60_000);
      lateMin = late >= 2 ? late : null;
      status = lateMin ? 'late' : 'on_time';
    } else if (r.missed_at || r.scheduled_end.getTime() <= now) status = 'missed';
    else continue; // its time has come but it's still running its window: not judged yet
    classes.push({
      sessionId: r.id,
      teacherId: r.teacher_id,
      teacher: r.teacher ?? 'No professor',
      courseCode: r.code,
      courseTitle: r.title,
      room: r.room,
      scheduledStart: r.scheduled_start.toISOString(),
      startedAt: r.started_at?.toISOString() ?? null,
      endedAt: r.ended_at?.toISOString() ?? null,
      status,
      lateMin,
      substitute: r.substitute,
    });
  }
  const by = new Map<string, PunctualityReport['teachers'][number] & { lateSum: number }>();
  for (const c of classes) {
    if (!c.teacherId) continue;
    const t = by.get(c.teacherId) ?? { teacherId: c.teacherId, name: c.teacher, classes: 0, onTime: 0, late: 0, missed: 0, cancelled: 0, avgLateMin: null, onTimePercent: null, lateSum: 0 };
    t.classes++;
    if (c.status === 'on_time') t.onTime++;
    else if (c.status === 'late') {
      t.late++;
      t.lateSum += c.lateMin ?? 0;
    } else if (c.status === 'missed') t.missed++;
    else t.cancelled++;
    by.set(c.teacherId, t);
  }
  const teachers = [...by.values()]
    .map(({ lateSum, ...t }) => {
      const due = t.onTime + t.late + t.missed;
      return { ...t, avgLateMin: t.late ? Math.round((lateSum / t.late) * 10) / 10 : null, onTimePercent: due ? Math.round((t.onTime / due) * 1000) / 10 : null };
    })
    .sort((a, b) => (a.onTimePercent ?? 101) - (b.onTimePercent ?? 101) || a.name.localeCompare(b.name));
  return { ...h, from: from.toISOString(), to: to.toISOString(), teachers, classes };
}

const share = (present: number, expected: number) => ({ present, expected, percent: expected ? Math.round((present / expected) * 1000) / 10 : null });

/**
 * Attendance over time: per day, per subject, per batch, and how students are spread around the
 * minimum. "Expected" = every enrolled student × every class held (closed, or live with marks).
 * `teacherId` limits it to one professor's classes (a professor without the coordinator powers).
 */
export async function buildAnalytics(
  db: Queryable,
  tenantId: string,
  now: number,
  q: { days: number; batchId?: string; courseId?: string },
  teacherId: string | null,
): Promise<AttendanceAnalytics> {
  const { h, term } = await header(db, tenantId, now);
  const from = new Date(now - q.days * 86_400_000);
  const params = [tenantId, from, term.timezone, q.batchId ?? null, q.courseId ?? null, teacherId];
  // One row per (class, enrolled student) with whether they were present — the base of every figure.
  const base = `
    with sess as (
      select s.id, s.course_id, to_char((s.started_at at time zone $3)::date, 'YYYY-MM-DD') as day
        from class_sessions s join courses c on c.id = s.course_id
       where s.tenant_id = $1 and s.started_at >= $2 and s.mode is not null
         and (s.status = 'closed' or (s.status = 'live' and exists(select 1 from attendance_records x where x.session_id = s.id and x.revoked_at is null)))
         and ($5::uuid is null or s.course_id = $5)
         and ($4::uuid is null or s.course_id in (select course_id from course_batches where batch_id = $4))
         and ($6::uuid is null or coalesce(s.substitute_id, c.instructor_id) = $6)
    ), roster as (
      select s.id as session_id, s.course_id, s.day, e.user_id,
             exists(select 1 from attendance_records a where a.session_id = s.id and a.user_id = e.user_id and a.revoked_at is null) as present
        from sess s
        join enrollments e on e.course_id = s.course_id
        join users u on u.id = e.user_id and u.status = 'active' and u.role = 'student'
       where ($4::uuid is null or e.user_id in (select user_id from batch_members where batch_id = $4))
    )`;
  const [days, subjects, students, batches, batchDays, scope] = await Promise.all([
    db.query<{ day: string; classes: number; expected: number; present: number }>(
      `${base} select s.day, count(distinct s.id)::int as classes, count(r.user_id)::int as expected, count(r.user_id) filter (where r.present)::int as present
         from sess s left join roster r on r.session_id = s.id group by s.day order by s.day`,
      params,
    ),
    db.query<{ course_id: string; code: string; title: string; classes: number; expected: number; present: number }>(
      `${base} select c.id as course_id, c.code, c.title, count(distinct s.id)::int as classes, count(r.user_id)::int as expected, count(r.user_id) filter (where r.present)::int as present
         from sess s join courses c on c.id = s.course_id left join roster r on r.session_id = s.id group by c.id, c.code, c.title order by c.code`,
      params,
    ),
    db.query<{ user_id: string; expected: number; present: number }>(
      `${base} select user_id, count(*)::int as expected, count(*) filter (where present)::int as present from roster group by user_id`,
      params,
    ),
    q.batchId
      ? Promise.resolve({ rows: [] as { batch_id: string; name: string; expected: number; present: number }[] })
      : db.query<{ batch_id: string; name: string; expected: number; present: number }>(
          `${base} select b.id as batch_id, b.name, count(r.user_id)::int as expected, count(r.user_id) filter (where r.present)::int as present
             from batches b
             join batch_members m on m.batch_id = b.id
             join roster r on r.user_id = m.user_id and r.course_id in (select course_id from course_batches where batch_id = b.id)
            where b.tenant_id = $1 and b.active
            group by b.id, b.name order by b.name`,
          params,
        ),
    db.query<{ day: string; batch_id: string; expected: number; present: number }>(
      `${base} select r.day, b.id as batch_id, count(*)::int as expected, count(*) filter (where r.present)::int as present
         from roster r
         join batch_members m on m.user_id = r.user_id
         join batches b on b.id = m.batch_id and b.tenant_id = $1 and b.active and ($4::uuid is null or b.id = $4)
        where r.course_id in (select course_id from course_batches where batch_id = b.id)
        group by r.day, b.id order by r.day, b.id`,
      params,
    ),
    db.query<{ batch: string | null; course: string | null }>(
      `select (select name from batches where id = $1 and tenant_id = $3) as batch, (select code from courses where id = $2 and tenant_id = $3) as course`,
      [q.batchId ?? null, q.courseId ?? null, tenantId],
    ),
  ]);
  const min = term.min_attendance;
  const bands = { safe: 0, near: 0, below: 0, far: 0 };
  for (const s of students.rows) {
    const p = s.expected ? (s.present / s.expected) * 100 : null;
    if (p === null) continue;
    if (p >= min + 10) bands.safe++;
    else if (p >= min) bands.near++;
    else if (p >= min - 15) bands.below++;
    else bands.far++;
  }
  const tot = days.rows.reduce((t, d) => ({ classes: t.classes + d.classes, expected: t.expected + d.expected, present: t.present + d.present }), { classes: 0, expected: 0, present: 0 });
  const sc = scope.rows[0] ?? { batch: null, course: null };
  const label = [sc.batch, sc.course].filter(Boolean).join(' · ') || (teacherId ? 'My classes' : 'Whole institution');
  return {
    ...h,
    scope: { label, batchId: q.batchId ?? null, courseId: q.courseId ?? null, mine: !!teacherId },
    from: from.toISOString(),
    to: new Date(now).toISOString(),
    days: days.rows.map((d) => ({ date: d.day, classes: d.classes, ...share(d.present, d.expected) })),
    total: { classes: tot.classes, ...share(tot.present, tot.expected) },
    subjects: subjects.rows.map((s) => ({ courseId: s.course_id, code: s.code, title: s.title, classes: s.classes, ...share(s.present, s.expected) })),
    batches: batches.rows.map((b) => ({ batchId: b.batch_id, name: b.name, ...share(b.present, b.expected) })),
    bands,
    batchDays: batchDays.rows.map((r) => ({ date: r.day, batchId: r.batch_id, present: r.present, expected: r.expected })),
  };
}

/** A student's own attendance, week by week, over the last `weeks` weeks of the term. */
export async function buildStudentTrend(db: Queryable, tenantId: string, userId: string, weeks: number): Promise<StudentTrend> {
  const term = await loadTenantTerm(db, tenantId);
  const { rows } = await db.query<{ week: string; held: number; attended: number }>(
    `select to_char(date_trunc('week', s.started_at at time zone $3)::date, 'YYYY-MM-DD') as week,
            count(*) filter (where s.status = 'closed' or a.id is not null)::int as held,
            count(a.id)::int as attended
       from enrollments e
       join class_sessions s on s.course_id = e.course_id and s.status in ('live', 'closed')
       left join attendance_records a on a.session_id = s.id and a.user_id = e.user_id and a.revoked_at is null
      where e.user_id = $1 and s.started_at >= greatest($2::date::timestamp at time zone $3, now() - make_interval(weeks => $4))
      group by 1 order by 1`,
    [userId, term.term_start, term.timezone, weeks],
  );
  return {
    minPercent: term.min_attendance,
    weeks: rows.filter((r) => r.held > 0).map((r) => ({ weekStart: r.week, attended: r.attended, held: r.held, percent: Math.round((r.attended / r.held) * 1000) / 10 })),
  };
}
