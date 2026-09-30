/**
 * Timetable planner: the shared engine behind drag-and-drop drafts, one-off
 * adjustments (reschedule / cancel / substitute / extra class) and permanent
 * weekly changes.
 *
 * Pure functions over a *week view* in the institution's local time, so the
 * Institute app can show clashes instantly while dragging, and the server can
 * run exactly the same checks again before publishing.
 */
import { z } from 'zod';
import { SessionStatus } from './schemas';
import { HHMM, SessionMode, Slot, YMD } from './staff';

const uuid = z.uuid();

// ───────────────────────────── the week view ─────────────────────────────

export const PlannerItem = z.object({
  /** Stable id on the board: the session id, or "new:<tempId>" for a class added in the draft. */
  key: z.string(),
  sessionId: uuid.nullable(),
  slotId: uuid.nullable(),
  courseId: uuid,
  date: YMD,
  start: HHMM,
  end: HHMM,
  roomId: uuid.nullable(),
  /** Who actually teaches it (a substitute, else the course's teacher). */
  teacherId: uuid.nullable(),
  substitute: z.boolean(),
  status: SessionStatus,
  mode: SessionMode,
  /** Running, finished or already over: cannot be moved any more. */
  locked: z.boolean(),
  /** Already has a published one-off change (so weekly edits leave it alone). */
  adjusted: z.boolean(),
  /** What the current draft does to it (for highlighting on the board). */
  pending: z.array(z.string()).default([]),
});
export type PlannerItem = z.infer<typeof PlannerItem>;

export const PlannerCourse = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  kind: z.enum(['theory', 'lab']),
  defaultMode: SessionMode,
  instructorId: uuid.nullable(),
  instructorName: z.string().nullable(),
  batchIds: z.array(uuid),
  /** Enrolled students as small anonymous numbers (only used to find clashes). */
  students: z.array(z.number().int().nonnegative()),
  active: z.boolean(),
});
export type PlannerCourse = z.infer<typeof PlannerCourse>;

export const PlannerWeek = z.object({
  weekStart: YMD,
  timezone: z.string(),
  today: YMD,
  now: HHMM,
  items: z.array(PlannerItem),
  slots: z.array(Slot),
  courses: z.array(PlannerCourse),
  teachers: z.array(z.object({ id: uuid, name: z.string(), role: z.string() })),
  rooms: z.array(z.object({ id: uuid, name: z.string() })),
  batches: z.array(z.object({ id: uuid, name: z.string(), size: z.number().int() })),
});
export type PlannerWeek = z.infer<typeof PlannerWeek>;

// ───────────────────────────── draft operations ─────────────────────────────

const when = { date: YMD, start: HHMM, end: HHMM };
const tempId = z.string().regex(/^[A-Za-z0-9_-]{4,40}$/);
const reason = z.string().trim().min(3, 'Give a short reason').max(200);

export const DraftOp = z.discriminatedUnion('op', [
  /** One class moves (this date only): new date/time and optionally another room. */
  z.object({ op: z.literal('reschedule'), sessionId: uuid, ...when, roomId: uuid.nullable().optional() }),
  z.object({ op: z.literal('cancel'), sessionId: uuid, reason }),
  /** Another teacher takes this one class (null = back to the course's own teacher). */
  z.object({
    op: z.literal('substitute'),
    sessionId: uuid,
    teacherId: uuid.nullable(),
    /** Shown to the teacher who is asked to take the class. */
    noteToTeacher: z.string().trim().max(300).optional(),
    /** Shown to the students (when the change takes effect). */
    noteToStudents: z.string().trim().max(300).optional(),
    /** true: the class is theirs on publish, no acceptance step; otherwise the teacher is asked first. */
    assign: z.boolean().optional(),
  }),
  /** A one-off class (make-up / extra), optionally by another teacher. */
  z.object({ op: z.literal('extra'), tempId, courseId: uuid, ...when, roomId: uuid.nullable().optional(), teacherId: uuid.nullable().optional(), mode: SessionMode.optional() }),
  /** Permanent: the weekly slot moves (every week from now on). */
  z.object({ op: z.literal('slot.update'), slotId: uuid, weekday: z.number().int().min(0).max(6), start: HHMM, end: HHMM, roomId: uuid.nullable().optional(), courseId: uuid.optional() }),
  z.object({ op: z.literal('slot.create'), tempId, courseId: uuid, weekday: z.number().int().min(0).max(6), start: HHMM, end: HHMM, roomId: uuid.nullable().optional(), mode: SessionMode.optional() }),
  z.object({ op: z.literal('slot.delete'), slotId: uuid }),
]);
export type DraftOp = z.infer<typeof DraftOp>;
export const DraftOps = z.array(DraftOp).max(300);

export const PlannerConflict = z.object({
  kind: z.enum(['teacher', 'room', 'course', 'students']),
  severity: z.enum(['error', 'warning']),
  keys: z.tuple([z.string(), z.string()]),
  date: YMD,
  message: z.string(),
});
export type PlannerConflict = z.infer<typeof PlannerConflict>;

export const OpError = z.object({ index: z.number().int(), message: z.string() });
export type OpError = z.infer<typeof OpError>;

// ───────────────────────────── date helpers (local calendar) ─────────────────────────────

function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}
export function addDaysYmd(ymd: string, days: number): string {
  const t = ymdToUtc(ymd);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(ymd: string): number {
  return ymdToUtc(ymd).getUTCDay();
}
/** The Monday on or before a date. */
export function mondayOf(ymd: string): string {
  return addDaysYmd(ymd, -((weekdayOf(ymd) + 6) % 7));
}
/** The date of a weekday inside the week starting on Monday `weekStart`. */
export function dateInWeek(weekStart: string, weekday: number): string {
  return addDaysYmd(weekStart, (weekday + 6) % 7);
}
export function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h! * 60 + m!;
}
export function minToHm(min: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** True if the class starts in the past (it can no longer be moved). */
export function isPast(date: string, start: string, today: string, now: string): boolean {
  return date < today || (date === today && start <= now);
}

// ───────────────────────────── applying a draft ─────────────────────────────

const opTarget = (o: DraftOp): string =>
  'sessionId' in o ? `s:${o.sessionId}` : 'slotId' in o ? `slot:${o.slotId}` : `new:${(o as { tempId: string }).tempId}`;

/**
 * The week as it would look after the draft is published.
 * Invalid operations (unknown or locked classes, times the wrong way round,
 * moves into the past) are reported in `errors` and skipped — never guessed.
 */
export function applyOps(week: Pick<PlannerWeek, 'weekStart' | 'today' | 'now' | 'items' | 'courses' | 'slots'>, ops: readonly DraftOp[]): { items: PlannerItem[]; errors: OpError[] } {
  const items = new Map(week.items.map((i) => [i.key, { ...i, pending: [...i.pending] }]));
  const bySession = new Map(week.items.filter((i) => i.sessionId).map((i) => [i.sessionId!, i.key]));
  const courses = new Map(week.courses.map((c) => [c.id, c]));
  const slots = new Map(week.slots.map((s) => [s.id, s]));
  const errors: OpError[] = [];
  const weekEnd = addDaysYmd(week.weekStart, 7);
  const inWeek = (d: string) => d >= week.weekStart && d < weekEnd;

  ops.forEach((o, index) => {
    const fail = (message: string) => errors.push({ index, message });
    if ('start' in o && 'end' in o && o.end <= o.start) return fail('The class must end after it starts.');
    switch (o.op) {
      case 'reschedule':
      case 'cancel':
      case 'substitute': {
        const key = bySession.get(o.sessionId);
        const it = key ? items.get(key) : undefined;
        if (!it) return; // outside this week: checked by the server against the real class
        if (it.locked || it.status !== 'scheduled') return fail('That class has already started or ended, so it can’t be changed.');
        if (o.op === 'reschedule') {
          if (isPast(o.date, o.start, week.today, week.now)) return fail('You can’t move a class into the past.');
          if (!inWeek(o.date)) {
            items.delete(it.key); // moved to another week: gone from this one
            return;
          }
          Object.assign(it, { date: o.date, start: o.start, end: o.end, roomId: o.roomId === undefined ? it.roomId : o.roomId });
        } else if (o.op === 'cancel') it.status = 'cancelled';
        else {
          const course = courses.get(it.courseId);
          it.teacherId = o.teacherId ?? course?.instructorId ?? null;
          it.substitute = !!o.teacherId && o.teacherId !== course?.instructorId;
        }
        it.pending.push(o.op);
        return;
      }
      case 'extra': {
        const course = courses.get(o.courseId);
        if (!course) return fail('Unknown course.');
        if (isPast(o.date, o.start, week.today, week.now)) return fail('An extra class must be in the future.');
        if (!inWeek(o.date)) return;
        items.set(`new:${o.tempId}`, {
          key: `new:${o.tempId}`,
          sessionId: null,
          slotId: null,
          courseId: o.courseId,
          date: o.date,
          start: o.start,
          end: o.end,
          roomId: o.roomId ?? null,
          teacherId: o.teacherId ?? course.instructorId,
          substitute: !!o.teacherId && o.teacherId !== course.instructorId,
          status: 'scheduled',
          mode: o.mode ?? course.defaultMode,
          locked: false,
          adjusted: false,
          pending: ['extra'],
        });
        return;
      }
      case 'slot.update':
      case 'slot.delete': {
        if (!slots.has(o.slotId)) return fail('That weekly slot no longer exists.');
        for (const it of [...items.values()]) {
          if (it.slotId !== o.slotId || it.locked || it.adjusted || it.status !== 'scheduled') continue;
          if (o.op === 'slot.delete') {
            items.delete(it.key);
            continue;
          }
          const date = dateInWeek(week.weekStart, o.weekday);
          if (isPast(date, o.start, week.today, week.now)) {
            items.delete(it.key); // the new time has already passed this week
            continue;
          }
          const course = o.courseId ? courses.get(o.courseId) : undefined;
          Object.assign(it, {
            date,
            start: o.start,
            end: o.end,
            roomId: o.roomId === undefined ? it.roomId : o.roomId,
            ...(course ? { courseId: course.id, teacherId: it.substitute ? it.teacherId : course.instructorId } : {}),
          });
          it.pending.push('weekly');
        }
        return;
      }
      case 'slot.create': {
        const course = courses.get(o.courseId);
        if (!course) return fail('Unknown course.');
        const date = dateInWeek(week.weekStart, o.weekday);
        if (isPast(date, o.start, week.today, week.now)) return; // starts next week
        items.set(`new:${o.tempId}`, {
          key: `new:${o.tempId}`,
          sessionId: null,
          slotId: null,
          courseId: o.courseId,
          date,
          start: o.start,
          end: o.end,
          roomId: o.roomId ?? null,
          teacherId: course.instructorId,
          substitute: false,
          status: 'scheduled',
          mode: o.mode ?? course.defaultMode,
          locked: false,
          adjusted: false,
          pending: ['weekly'],
        });
        return;
      }
    }
  });
  return { items: [...items.values()].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)), errors };
}

// ───────────────────────────── clashes ─────────────────────────────

/**
 * Every pair of classes that overlap in time and share a teacher, a room, the
 * same course, or students. Teacher/room/course clashes are errors (publishing
 * is refused); shared students are warnings (e.g. electives) that an admin can
 * accept knowingly.
 */
export function findConflicts(
  items: readonly Pick<PlannerItem, 'key' | 'courseId' | 'date' | 'start' | 'end' | 'roomId' | 'teacherId' | 'status'>[],
  courses: readonly Pick<PlannerCourse, 'id' | 'code' | 'students'>[],
  names: { teachers?: Map<string, string>; rooms?: Map<string, string> } = {},
): PlannerConflict[] {
  const course = new Map(courses.map((c) => [c.id, c]));
  const studentSets = new Map<string, Set<number>>();
  const setOf = (id: string) => {
    let s = studentSets.get(id);
    if (!s) studentSets.set(id, (s = new Set(course.get(id)?.students ?? [])));
    return s;
  };
  const code = (id: string) => course.get(id)?.code ?? 'class';
  const out: PlannerConflict[] = [];
  const byDate = new Map<string, typeof items>();
  for (const it of items) if (it.status !== 'cancelled') byDate.set(it.date, [...(byDate.get(it.date) ?? []), it]);

  for (const [date, list] of byDate) {
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]!;
        if (b.start >= a.end) break; // sorted by start: nothing later can overlap a
        const keys: [string, string] = [a.key, b.key];
        const at = `${date} ${b.start > a.start ? b.start : a.start}`;
        if (a.teacherId && a.teacherId === b.teacherId)
          out.push({ kind: 'teacher', severity: 'error', keys, date, message: `${names.teachers?.get(a.teacherId) ?? 'The teacher'} would teach ${code(a.courseId)} and ${code(b.courseId)} at once (${at}).` });
        if (a.roomId && a.roomId === b.roomId)
          out.push({ kind: 'room', severity: 'error', keys, date, message: `${names.rooms?.get(a.roomId) ?? 'The room'} is double-booked: ${code(a.courseId)} and ${code(b.courseId)} (${at}).` });
        if (a.courseId === b.courseId) {
          out.push({ kind: 'course', severity: 'error', keys, date, message: `${code(a.courseId)} is scheduled twice at the same time (${at}).` });
          continue;
        }
        const sa = setOf(a.courseId);
        const sb = setOf(b.courseId);
        const [small, big] = sa.size < sb.size ? [sa, sb] : [sb, sa];
        let shared = 0;
        for (const s of small) if (big.has(s)) shared++;
        if (shared)
          out.push({
            kind: 'students',
            severity: 'warning',
            keys,
            date,
            message: `${shared} ${shared === 1 ? 'student has' : 'students have'} both ${code(a.courseId)} and ${code(b.courseId)} at ${at}.`,
          });
      }
    }
  }
  return out;
}

// ───────────────────────────── editing a draft (used by the board) ─────────────────────────────

/** Adds an operation, folding it into an earlier one on the same class so drafts stay short. */
export function upsertOp(ops: readonly DraftOp[], next: DraftOp): DraftOp[] {
  const target = opTarget(next);
  // Changes to a class added in this draft rewrite that "extra"/"slot.create" itself.
  const kindsReplacing: Record<DraftOp['op'], DraftOp['op'][]> = {
    reschedule: ['reschedule'],
    cancel: ['cancel', 'reschedule', 'substitute'],
    substitute: ['substitute'],
    extra: ['extra'],
    'slot.update': ['slot.update'],
    'slot.create': ['slot.create'],
    'slot.delete': ['slot.delete', 'slot.update'],
  };
  const drop = new Set(kindsReplacing[next.op]);
  return [...ops.filter((o) => !(opTarget(o) === target && drop.has(o.op))), next];
}

/** Removes every draft change to one class (the board's "undo changes to this class"). */
export function removeOpsFor(ops: readonly DraftOp[], key: string, slotId: string | null): DraftOp[] {
  return ops.filter((o) => {
    const t = opTarget(o);
    if (key.startsWith('new:')) return t !== key;
    return t !== `s:${key}` && !(slotId && t === `slot:${slotId}`);
  });
}

/**
 * The drag-and-drop move: produces the right operation for a class dropped on a
 * new day/time — a one-off reschedule, a weekly slot change, or an edit of a
 * class that only exists in this draft.
 */
export function moveOp(
  item: Pick<PlannerItem, 'key' | 'sessionId' | 'slotId' | 'courseId' | 'roomId' | 'mode'>,
  to: { date: string; start: string; end: string; roomId?: string | null },
  scope: 'once' | 'weekly',
  existing: readonly DraftOp[],
): DraftOp | null {
  const roomId = to.roomId === undefined ? item.roomId : to.roomId;
  if (item.key.startsWith('new:')) {
    const prior = existing.find((o) => opTarget(o) === item.key);
    if (prior?.op === 'extra') return { ...prior, date: to.date, start: to.start, end: to.end, roomId };
    if (prior?.op === 'slot.create') return { ...prior, weekday: weekdayOf(to.date), start: to.start, end: to.end, roomId };
    return null;
  }
  if (scope === 'weekly' && item.slotId) return { op: 'slot.update', slotId: item.slotId, weekday: weekdayOf(to.date), start: to.start, end: to.end, roomId };
  if (!item.sessionId) return null;
  return { op: 'reschedule', sessionId: item.sessionId, date: to.date, start: to.start, end: to.end, roomId };
}

/** Swapping two classes' times (drop one onto the other): two moves in one go. */
export function swapOps(
  a: Pick<PlannerItem, 'key' | 'sessionId' | 'slotId' | 'courseId' | 'roomId' | 'mode' | 'date' | 'start' | 'end'>,
  b: Pick<PlannerItem, 'key' | 'sessionId' | 'slotId' | 'courseId' | 'roomId' | 'mode' | 'date' | 'start' | 'end'>,
  scope: 'once' | 'weekly',
  existing: readonly DraftOp[],
): DraftOp[] {
  let ops = [...existing];
  const aDur = hmToMin(a.end) - hmToMin(a.start);
  const bDur = hmToMin(b.end) - hmToMin(b.start);
  const ma = moveOp(a, { date: b.date, start: b.start, end: minToHm(hmToMin(b.start) + aDur), roomId: b.roomId }, scope, ops);
  const mb = moveOp(b, { date: a.date, start: a.start, end: minToHm(hmToMin(a.start) + bDur), roomId: a.roomId }, scope, ops);
  if (ma) ops = upsertOp(ops, ma);
  if (mb) ops = upsertOp(ops, mb);
  return ops;
}

export function opCounts(ops: readonly DraftOp[]): { once: number; weekly: number } {
  let once = 0;
  let weekly = 0;
  for (const o of ops) if (o.op.startsWith('slot.')) weekly++;
  else once++;
  return { once, weekly };
}
