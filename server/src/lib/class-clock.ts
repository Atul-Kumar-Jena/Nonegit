/**
 * The class clock. A class has two logged moments:
 *   1. its time starts — logged here, and the professor is reminded to start it;
 *   2. the professor arrives and starts it (makes it live) — from the Institute app; the batch sees
 *      the class as live, and the professor opens the QR for attendance when they choose.
 * A class whose time runs out without being started is logged as missed. When the QR is on screen,
 * students are told "attendance is being taken". (Classes started by the older clock still close
 * 15 minutes after their end.)
 */
import type { Db, Queryable } from '../db';
import { withTx } from '../db';
import { appendAudit } from './audit';
import { insertNotifications } from './notify';

/** Classes started by the clock (older builds) close this long after their scheduled end. */
export const AUTO_CLOSE_AFTER_MS = 15 * 60_000;
/** The QR counts as "on screen" for this long after the last sign of it. */
export const SHOWING_FOR_MS = 90_000;

interface DueRow {
  id: string;
  tenant_id: string;
  teacher_id: string | null;
  code: string;
  room: string | null;
}

export async function tickClasses(db: Db, now: Date): Promise<{ due: number; missed: number; closed: number }> {
  return withTx(db, async (tx) => {
    // Log 1: the class time has started. Remind whoever teaches it to start it once they're in class.
    const due = await tx.query<DueRow>(
      `update class_sessions s set due_at = $1
         from courses c
        where c.id = s.course_id and s.status = 'scheduled' and s.due_at is null and s.scheduled_start <= $1 and s.scheduled_end > $1
        returning s.id, s.tenant_id, coalesce(s.substitute_id, c.instructor_id) as teacher_id, c.code,
                  (select coalesce(r.name, s.room) from rooms r where r.id = s.room_id) as room`,
      [now],
    );
    const byTenant = new Map<string, DueRow[]>();
    for (const s of due.rows) {
      await appendAudit(tx, { tenantId: s.tenant_id, actorType: 'system', action: 'session.due', subject: `session:${s.id}` });
      if (s.teacher_id) byTenant.set(s.tenant_id, [...(byTenant.get(s.tenant_id) ?? []), s]);
    }
    for (const [tenantId, list] of byTenant)
      await insertNotifications(
        tx,
        tenantId,
        list.map((s) => ({
          userId: s.teacher_id!,
          kind: 'live',
          title: `⏰ ${s.code} starts now`,
          body: `${s.room ? `${s.room} · ` : ''}When you’re in class, tap Start — your students see the class as live. Open the QR for attendance whenever you like.`,
          data: { sessionId: s.id },
        })),
      );

    // The class time ran out and nobody started it: logged as missed.
    const missed = await tx.query<{ id: string; tenant_id: string }>(
      `update class_sessions set missed_at = $1
        where status = 'scheduled' and missed_at is null and scheduled_end <= $1 and scheduled_start > $1::timestamptz - interval '2 days'
        returning id, tenant_id`,
      [now],
    );
    for (const s of missed.rows) await appendAudit(tx, { tenantId: s.tenant_id, actorType: 'system', action: 'session.missed', subject: `session:${s.id}` });

    const closed = await tx.query(
      `update class_sessions set status = 'closed', ended_at = scheduled_end
        where status = 'live' and auto_started and scheduled_end <= $1`,
      [new Date(now.getTime() - AUTO_CLOSE_AFTER_MS)],
    );
    return { due: due.rowCount ?? 0, missed: missed.rowCount ?? 0, closed: closed.rowCount ?? 0 };
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

/** Log 2: the professor started the class — the batch sees it live (one quiet notification each). */
export async function announceStarted(db: Queryable, sessionId: string): Promise<void> {
  const s = (
    await db.query<{ tenant_id: string; course_id: string; code: string; title: string; teacher: string | null; room: string | null }>(
      `select s.tenant_id, s.course_id, c.code, c.title, coalesce(su.full_name, iu.full_name) as teacher, coalesce(r.name, s.room) as room
         from class_sessions s join courses c on c.id = s.course_id
         left join users su on su.id = s.substitute_id left join users iu on iu.id = c.instructor_id left join rooms r on r.id = s.room_id
        where s.id = $1`,
      [sessionId],
    )
  ).rows[0];
  if (!s) return;
  const students = await db.query<{ id: string }>(
    `select e.user_id as id from enrollments e join users u on u.id = e.user_id where e.course_id = $1 and u.status = 'active' and u.role = 'student'`,
    [s.course_id],
  );
  await insertNotifications(
    db,
    s.tenant_id,
    students.rows.map((u) => ({
      userId: u.id,
      kind: 'started',
      title: `▶ ${s.code} has started`,
      body: `${s.teacher ? `${s.teacher} is in class` : 'Your class has started'}${s.room ? ` · ${s.room}` : ''}.`,
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
      if (r.due || r.missed || r.closed) log(`class clock: ${r.due} due, ${r.missed} missed, ${r.closed} closed`);
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
