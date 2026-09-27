/**
 * The class clock: every class goes live by itself at its start time (its professor is told to
 * open the QR), classes started this way close 15 minutes after they end, and when the QR is on
 * screen students are told "attendance is being taken".
 */
import type { Db, Queryable } from '../db';
import { withTx } from '../db';
import { insertNotifications } from './notify';
import { assignLectureNo } from './sessions';

/** Classes started by the clock close this long after their scheduled end. */
export const AUTO_CLOSE_AFTER_MS = 15 * 60_000;
/** The QR counts as "on screen" for this long after the last sign of it. */
export const SHOWING_FOR_MS = 90_000;

export async function tickClasses(db: Db, now: Date): Promise<{ started: number; closed: number }> {
  return withTx(db, async (tx) => {
    // A QR class needs to know where the classroom is; a paper register doesn't.
    const started = await tx.query<{ id: string; tenant_id: string; teacher_id: string | null; code: string; room: string | null }>(
      `update class_sessions s set status = 'live', started_at = s.scheduled_start, auto_started = true
         from courses c
        where c.id = s.course_id and s.status = 'scheduled' and s.scheduled_start <= $1 and s.scheduled_end > $1
          and (s.mode = 'manual' or (s.lat is not null and s.lng is not null))
        returning s.id, s.tenant_id, coalesce(s.substitute_id, c.instructor_id) as teacher_id, c.code,
                  (select coalesce(r.name, s.room) from rooms r where r.id = s.room_id) as room`,
      [now],
    );
    for (const s of started.rows) await assignLectureNo(tx, s.id);
    const byTenant = new Map<string, typeof started.rows>();
    for (const s of started.rows) if (s.teacher_id) byTenant.set(s.tenant_id, [...(byTenant.get(s.tenant_id) ?? []), s]);
    for (const [tenantId, list] of byTenant)
      await insertNotifications(
        tx,
        tenantId,
        list.map((s) => ({
          userId: s.teacher_id!,
          kind: 'live',
          title: `▶ ${s.code} is live now`,
          body: `${s.room ? `${s.room} · ` : ''}Open the QR so students can mark attendance.`,
          data: { sessionId: s.id },
        })),
      );
    const closed = await tx.query(
      `update class_sessions set status = 'closed', ended_at = scheduled_end
        where status = 'live' and auto_started and scheduled_end <= $1`,
      [new Date(now.getTime() - AUTO_CLOSE_AFTER_MS)],
    );
    return { started: started.rowCount ?? 0, closed: closed.rowCount ?? 0 };
  });
}

/** The QR of this live class is on screen now; the first time, its students are told to scan. */
export async function markShowing(db: Queryable, sessionId: string, now: Date): Promise<void> {
  const { rows } = await db.query<{ tenant_id: string; course_id: string; code: string; title: string; first: boolean }>(
    `update class_sessions s set qr_shown_at = $2, taking_notified_at = coalesce(s.taking_notified_at, $2)
       from courses c
      where s.id = $1 and c.id = s.course_id and s.status = 'live'
        and (s.qr_shown_at is null or s.qr_shown_at < $2::timestamptz - interval '20 seconds')
      returning s.tenant_id, s.course_id, c.code, c.title, (s.taking_notified_at = $2) as first`,
    [sessionId, now],
  );
  const s = rows[0];
  if (!s?.first) return;
  const students = await db.query<{ id: string }>(
    `select e.user_id as id from enrollments e join users u on u.id = e.user_id
      where e.course_id = $1 and u.status = 'active' and u.role = 'student'
        and not exists (select 1 from attendance_records a where a.session_id = $2 and a.user_id = e.user_id)`,
    [s.course_id, sessionId],
  );
  await insertNotifications(
    db,
    s.tenant_id,
    students.rows.map((u) => ({
      userId: u.id,
      kind: 'taking',
      title: `📸 Attendance being taken · ${s.code}`,
      body: `${s.title}: scan the code on screen now.`,
      data: { sessionId, courseId: s.course_id },
    })),
  );
}

/** Runs the class clock every 20 seconds. */
export function startClassClock(db: Db, clock: () => number, log: (msg: string) => void): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await tickClasses(db, new Date(clock()));
      if (r.started || r.closed) log(`class clock: ${r.started} started, ${r.closed} closed`);
    } catch (err) {
      log(`class clock error: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  void run();
  const t = setInterval(() => void run(), 20_000);
  t.unref();
  return () => clearInterval(t);
}
