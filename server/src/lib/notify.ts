/**
 * In-app notifications ("CS-101 moved to Wed 14:00"). Stored per person, fetched
 * by both apps, and turned into phone notifications by the apps themselves.
 */
import type { Queryable } from '../db';

export interface ChangeLine {
  kind: 'rescheduled' | 'cancelled' | 'substitute' | 'extra' | 'weekly';
  courseId: string;
  courseCode: string;
  text: string;
  sessionId?: string;
}

/** "Tue 30 Sep, 10:00 AM" in the institution's time zone. */
export function fmtWhen(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const h = Number(get('hour')) % 24;
  return `${get('weekday')} ${get('day')} ${get('month')}, ${h % 12 === 0 ? 12 : h % 12}:${get('minute')} ${h < 12 ? 'AM' : 'PM'}`;
}
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Active students enrolled in each course. */
export async function studentsOf(db: Queryable, courseIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!courseIds.length) return out;
  const { rows } = await db.query<{ course_id: string; user_id: string }>(
    `select e.course_id, e.user_id from enrollments e join users u on u.id = e.user_id and u.status = 'active' and u.role = 'student'
      where e.course_id = any($1::uuid[])`,
    [courseIds],
  );
  for (const r of rows) out.set(r.course_id, [...(out.get(r.course_id) ?? []), r.user_id]);
  return out;
}

let kicker: (() => void) | null = null;
/** Set by the push dispatcher: called after new notifications are written. */
export function onNewNotifications(fn: (() => void) | null): void {
  kicker = fn;
}
function kickPush(): void {
  kicker?.();
}

export async function insertNotifications(
  db: Queryable,
  tenantId: string,
  list: { userId: string; kind: string; title: string; body: string; data: Record<string, unknown> }[],
): Promise<number> {
  if (!list.length) return 0;
  await db.query(
    `insert into notifications(tenant_id, user_id, kind, title, body, data)
     select $1, u, k, t, b, d::jsonb from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[]) as x(u, k, t, b, d)`,
    [tenantId, list.map((n) => n.userId), list.map((n) => n.kind), list.map((n) => n.title), list.map((n) => n.body), list.map((n) => JSON.stringify(n.data))],
  );
  // Wake the push dispatcher now instead of at its next poll (it only sees rows once their transaction commits).
  kickPush();
  return list.length;
}

/**
 * One notification per person, listing every change that concerns them:
 * students of the affected courses, plus any staff passed in `staff`.
 */
export async function deliverChanges(
  db: Queryable,
  tenantId: string,
  lines: ChangeLine[],
  staff: Map<string, ChangeLine[]> = new Map(),
  opts: { skipUserId?: string } = {},
): Promise<number> {
  if (!lines.length && !staff.size) return 0;
  const byCourse = await studentsOf(db, [...new Set(lines.map((l) => l.courseId))]);
  const perUser = new Map<string, ChangeLine[]>();
  for (const l of lines) for (const u of byCourse.get(l.courseId) ?? []) perUser.set(u, [...(perUser.get(u) ?? []), l]);
  for (const [u, ls] of staff) perUser.set(u, [...(perUser.get(u) ?? []), ...ls]);
  if (opts.skipUserId) perUser.delete(opts.skipUserId);

  const list = [...perUser].map(([userId, ls]) => {
    const unique = [...new Map(ls.map((l) => [l.text, l])).values()];
    const title =
      unique.length === 1
        ? { rescheduled: 'Class moved', cancelled: 'Class cancelled', substitute: 'Different teacher', extra: 'Extra class', weekly: 'Timetable changed' }[unique[0]!.kind]
        : `Timetable updated · ${unique.length} changes`;
    const shown = unique.slice(0, 6).map((l) => `• ${l.text}`);
    if (unique.length > 6) shown.push(`…and ${unique.length - 6} more`);
    return {
      userId,
      kind: 'timetable',
      title: unique.length === 1 ? `${title} · ${unique[0]!.courseCode}` : title,
      body: shown.join('\n'),
      data: { changes: unique.map((l) => ({ kind: l.kind, courseId: l.courseId, courseCode: l.courseCode, sessionId: l.sessionId ?? null })) },
    };
  });
  return insertNotifications(db, tenantId, list);
}
