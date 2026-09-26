import type { SessionChange, StaffSession } from '@attendly/protocol';
import type { Queryable } from '../db';

export interface StaffSessionRow {
  id: string;
  short_code: string;
  course_id: string;
  course_code: string;
  course_title: string;
  lecture_no: number | null;
  status: StaffSession['status'];
  mode: StaffSession['mode'];
  scheduled_start: Date;
  scheduled_end: Date;
  started_at: Date | null;
  ended_at: Date | null;
  room_id: string | null;
  room_name: string | null;
  room_label: string | null;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  rotation_s: number;
  marked: number;
  enrolled: number;
  flagged: number;
  instructor_id: string | null;
  instructor_name: string | null;
  substitute_id: string | null;
  substitute_name: string | null;
  original_start: Date | null;
  change_kind: 'rescheduled' | 'substitute' | 'extra' | 'cancelled' | null;
  change_note: string | null;
}

export const STAFF_SESSION_SELECT = `
  select s.id, s.short_code, s.course_id, c.code as course_code, c.title as course_title, s.lecture_no, s.status, s.mode,
         s.scheduled_start, s.scheduled_end, s.started_at, s.ended_at, s.room_id, r.name as room_name, s.room as room_label,
         s.lat, s.lng, s.radius_m, s.rotation_s,
         (select count(*) from attendance_records a where a.session_id = s.id and a.revoked_at is null) as marked,
         (select count(*) from enrollments e join users u on u.id = e.user_id and u.status = 'active' where e.course_id = s.course_id) as enrolled,
         (select count(*) from scan_rejections x where x.session_id = s.id and x.suspicious and x.review_status = 'open') as flagged,
         c.instructor_id, iu.full_name as instructor_name, s.substitute_id, su.full_name as substitute_name,
         s.original_start, s.change_kind, s.change_note
    from class_sessions s
    join courses c on c.id = s.course_id
    left join rooms r on r.id = s.room_id
    left join users iu on iu.id = c.instructor_id
    left join users su on su.id = s.substitute_id`;

/** The change shown on a class (moved / someone else teaching / extra / cancelled). */
export function sessionChange(r: {
  change_kind: 'rescheduled' | 'substitute' | 'extra' | 'cancelled' | null;
  change_note: string | null;
  original_start: Date | null;
  substitute_name: string | null;
}): SessionChange | null {
  if (!r.change_kind) return r.substitute_name ? { kind: 'substitute', note: null, originalStart: null, teacher: r.substitute_name } : null;
  return { kind: r.change_kind, note: r.change_note, originalStart: r.original_start?.toISOString() ?? null, teacher: r.substitute_name };
}

export function toStaffSession(r: StaffSessionRow): StaffSession {
  return {
    id: r.id,
    code: r.short_code,
    courseId: r.course_id,
    courseCode: r.course_code,
    courseTitle: r.course_title,
    lectureNo: r.lecture_no,
    status: r.status,
    mode: r.mode,
    scheduledStart: r.scheduled_start.toISOString(),
    scheduledEnd: r.scheduled_end.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    endedAt: r.ended_at?.toISOString() ?? null,
    room: r.room_id && r.room_name ? { id: r.room_id, name: r.room_name } : null,
    roomLabel: r.room_name ?? r.room_label,
    lat: r.lat,
    lng: r.lng,
    radiusM: r.radius_m,
    rotationS: r.rotation_s,
    marked: r.marked,
    enrolled: r.enrolled,
    flagged: r.flagged,
    teacher: r.instructor_id && r.instructor_name ? { id: r.instructor_id, name: r.instructor_name } : null,
    substitute: r.substitute_id && r.substitute_name ? { id: r.substitute_id, name: r.substitute_name } : null,
    change: sessionChange(r),
  };
}

export async function loadStaffSession(db: Queryable, sessionId: string): Promise<StaffSession> {
  const { rows } = await db.query<StaffSessionRow>(`${STAFF_SESSION_SELECT} where s.id = $1`, [sessionId]);
  if (!rows[0]) throw new Error('session vanished');
  return toStaffSession(rows[0]);
}

/** Sessions of the institution (or of one teacher: their courses + classes they substitute) whose start falls in [from, to). */
export async function listStaffSessions(
  db: Queryable,
  p: { tenantId: string; instructorId: string | null; from: Date; to: Date; courseId?: string | null; includeLive?: boolean },
): Promise<StaffSession[]> {
  const { rows } = await db.query<StaffSessionRow>(
    `${STAFF_SESSION_SELECT}
      where s.tenant_id = $1 and ($2::uuid is null or c.instructor_id = $2 or s.substitute_id = $2) and ($5::uuid is null or s.course_id = $5)
        and ((s.scheduled_start >= $3 and s.scheduled_start < $4) or ($6 and s.status = 'live'))
      order by (s.status = 'live') desc, s.scheduled_start`,
    [p.tenantId, p.instructorId, p.from, p.to, p.courseId ?? null, p.includeLive ?? false],
  );
  return rows.map(toStaffSession);
}

/** [start, end) of a local calendar day in an IANA timezone, computed by the database. */
export async function localDayBounds(db: Queryable, timezone: string, ymd: string | null, spanDays = 1): Promise<{ from: Date; to: Date; ymd: string }> {
  const { rows } = await db.query<{ from: Date; to: Date; ymd: string }>(
    `select (d::timestamp at time zone $1) as from, ((d + $3::int)::timestamp at time zone $1) as to, to_char(d, 'YYYY-MM-DD') as ymd
       from (select coalesce($2::date, (now() at time zone $1)::date) as d) x`,
    [timezone, ymd, spanDays],
  );
  return rows[0]!;
}
