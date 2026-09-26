import type { Queryable } from '../db';
import type { AuthContext } from './auth';
import { ApiError } from './errors';

/**
 * Staff authorisation rules (enforced on every staff endpoint):
 *  • Everything is confined to the caller's institution (tenant).
 *  • Admins manage the whole institution.
 *  • Teachers see and act only on the courses they teach, and read-only
 *    on institution-wide lists (rooms, timetable of their courses).
 * Anything outside the caller's scope answers 404, so its existence never leaks.
 */
export const STAFF = ['teacher', 'admin'] as const;

export function isAdmin(auth: AuthContext): boolean {
  return auth.role === 'admin';
}

export function requireAdmin(auth: AuthContext): void {
  if (!isAdmin(auth)) throw new ApiError(403, 'FORBIDDEN', 'Only institution admins can do this.');
}

/** SQL fragment parameter: null for admins (no instructor filter), else the teacher's id. */
export function instructorFilter(auth: AuthContext): string | null {
  return isAdmin(auth) ? null : auth.userId;
}

export interface CourseRow {
  id: string;
  tenant_id: string;
  code: string;
  title: string;
  kind: 'theory' | 'lab';
  default_mode: 'qr' | 'manual';
  instructor_id: string | null;
  instructor_name: string | null;
  active: boolean;
  student_count: number;
}

export const COURSE_SELECT = `
  select c.id, c.tenant_id, c.code, c.title, c.kind, c.default_mode, c.instructor_id, i.full_name as instructor_name, c.active,
         (select count(*) from enrollments e join users su on su.id = e.user_id and su.status = 'active' where e.course_id = c.id) as student_count
    from courses c left join users i on i.id = c.instructor_id`;

export async function loadCourseFor(db: Queryable, auth: AuthContext, courseId: string): Promise<CourseRow> {
  const { rows } = await db.query<CourseRow>(`${COURSE_SELECT} where c.id = $1 and c.tenant_id = $2`, [courseId, auth.tenantId]);
  const c = rows[0];
  if (!c || (!isAdmin(auth) && c.instructor_id !== auth.userId)) throw new ApiError(404, 'NOT_FOUND', 'Course not found.');
  return c;
}

export interface SessionAccessRow {
  id: string;
  tenant_id: string;
  course_id: string;
  instructor_id: string | null;
  status: 'scheduled' | 'live' | 'closed' | 'cancelled';
  mode: 'qr' | 'manual';
  scheduled_start: Date;
  scheduled_end: Date;
  started_at: Date | null;
  ended_at: Date | null;
  started_by: string | null;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  rotation_s: number;
  room_id: string | null;
  qr_secret: Buffer;
  substitute_id: string | null;
  slot_id: string | null;
  change_kind: string | null;
}

export async function loadSessionFor(db: Queryable, auth: AuthContext, sessionId: string, forUpdate = false): Promise<SessionAccessRow> {
  const { rows } = await db.query<SessionAccessRow>(
    `select s.id, s.tenant_id, s.course_id, c.instructor_id, s.status, s.mode, s.scheduled_start, s.scheduled_end, s.started_at, s.ended_at,
            s.started_by, s.lat, s.lng, s.radius_m, s.rotation_s, s.room_id, s.qr_secret, s.substitute_id, s.slot_id, s.change_kind
       from class_sessions s join courses c on c.id = s.course_id
      where s.id = $1 and s.tenant_id = $2${forUpdate ? ' for update of s' : ''}`,
    [sessionId, auth.tenantId],
  );
  const s = rows[0];
  // A teacher reaches their own courses' classes, and any class they are substituting.
  if (!s || (!isAdmin(auth) && s.instructor_id !== auth.userId && s.substitute_id !== auth.userId)) throw new ApiError(404, 'NOT_FOUND', 'Class not found.');
  return s;
}

/** The course's own teacher (or an admin) — substitutes run a class but don't reorganise it. */
export function isOwnerOf(auth: AuthContext, s: Pick<SessionAccessRow, 'instructor_id'>): boolean {
  return isAdmin(auth) || s.instructor_id === auth.userId;
}
