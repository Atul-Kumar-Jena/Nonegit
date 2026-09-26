import type { Queryable } from '../db';

export interface TenantTerm {
  id: string;
  timezone: string;
  min_attendance: number;
  term_name: string;
  term_start: string; // YYYY-MM-DD
  device_reset_limit: number;
}

export async function loadTenantTerm(db: Queryable, tenantId: string): Promise<TenantTerm> {
  const { rows } = await db.query<TenantTerm>(
    `select id, timezone, min_attendance, term_name, to_char(term_start, 'YYYY-MM-DD') as term_start, device_reset_limit from tenants where id = $1`,
    [tenantId],
  );
  if (!rows[0]) throw new Error('tenant not found');
  return rows[0];
}

export interface CourseStatRow {
  course_id: string;
  code: string;
  title: string;
  kind: 'theory' | 'lab';
  instructor: string | null;
  held: number;
  attended: number;
  held_before_week: number;
  attended_before_week: number;
}

/**
 * Per-course attendance for one student this term.
 *
 * "Held" counts closed sessions, plus a live session only once the student has
 * marked it — so an in-progress class never drags the percentage down early.
 */
export async function courseStats(db: Queryable, userId: string, term: TenantTerm, courseId?: string): Promise<CourseStatRow[]> {
  const { rows } = await db.query<CourseStatRow>(
    `with bounds as (
       select ($2::date::timestamp at time zone $3) as term_start,
              (date_trunc('week', now() at time zone $3) at time zone $3) as week_start
     )
     select c.id as course_id, c.code, c.title, c.kind, i.full_name as instructor,
            count(s.id) filter (where s.status = 'closed' or a.id is not null) as held,
            count(a.id) as attended,
            count(s.id) filter (where (s.status = 'closed' or a.id is not null) and s.started_at < b.week_start) as held_before_week,
            count(a.id) filter (where s.started_at < b.week_start) as attended_before_week
       from enrollments e
       join courses c on c.id = e.course_id
       cross join bounds b
       left join users i on i.id = c.instructor_id
       left join class_sessions s on s.course_id = c.id and s.status in ('live', 'closed') and s.started_at >= b.term_start
       left join attendance_records a on a.session_id = s.id and a.user_id = e.user_id
      where e.user_id = $1 and ($4::uuid is null or c.id = $4)
      group by c.id, c.code, c.title, c.kind, i.full_name
      order by c.code`,
    [userId, term.term_start, term.timezone, courseId ?? null],
  );
  return rows;
}
