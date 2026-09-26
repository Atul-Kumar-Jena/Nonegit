import { attendancePercent, standing, type MatrixReport, type ReportHeader, type StudentReport } from '@attendly/protocol';
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

const HOW: Record<string, string> = { scan: 'QR scan', manual: 'Register', import: 'Imported', review: 'Approved by teacher' };

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
