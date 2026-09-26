import { describe, expect, it } from 'vitest';
import { DraftOps, addDaysYmd, applyOps, findConflicts, mondayOf, moveOp, swapOps, upsertOp, weekdayOf, type PlannerCourse, type PlannerItem, type PlannerWeek } from '../src';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T1 = U(901);
const T2 = U(902);
const R1 = U(801);
const R2 = U(802);
const course = (n: number, instructorId: string, students: number[]): PlannerCourse => ({
  id: U(n),
  code: `C-${n}`,
  title: `Course ${n}`,
  kind: 'theory',
  defaultMode: 'qr',
  instructorId,
  instructorName: null,
  batchIds: [],
  students,
  active: true,
});
const item = (n: number, courseId: string, date: string, start: string, end: string, extra: Partial<PlannerItem> = {}): PlannerItem => ({
  key: U(n),
  sessionId: U(n),
  slotId: null,
  courseId,
  date,
  start,
  end,
  roomId: R1,
  teacherId: T1,
  substitute: false,
  status: 'scheduled',
  mode: 'qr',
  locked: false,
  adjusted: false,
  pending: [],
  ...extra,
});

// Week of Monday 2026-09-28; "now" is Monday 08:00.
const C1 = course(1, T1, [1, 2, 3]);
const C2 = course(2, T2, [3, 4]);
const base = (): Pick<PlannerWeek, 'weekStart' | 'today' | 'now' | 'items' | 'courses' | 'slots'> => ({
  weekStart: '2026-09-28',
  today: '2026-09-28',
  now: '08:00',
  courses: [C1, C2],
  slots: [
    { id: U(500), courseId: C1.id, courseCode: 'C-1', courseTitle: 'Course 1', instructor: null, weekday: 2, start: '10:00', end: '11:00', room: { id: R1, name: 'LH-1' }, mode: 'qr', rotationS: 7, validFrom: '2026-09-01', validUntil: null, active: true },
  ],
  items: [
    item(11, C1.id, '2026-09-29', '10:00', '11:00', { slotId: U(500) }),
    item(12, C2.id, '2026-09-29', '11:00', '12:00', { teacherId: T2, roomId: R2 }),
    item(13, C1.id, '2026-09-28', '07:00', '07:50', { locked: true, status: 'closed' }),
  ],
});

describe('planner dates', () => {
  it('knows weeks and weekdays', () => {
    expect(weekdayOf('2026-09-28')).toBe(1);
    expect(mondayOf('2026-10-04')).toBe('2026-09-28');
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('applying a draft', () => {
  it('reschedules, cancels, substitutes and adds classes', () => {
    const w = base();
    const { items, errors } = applyOps(w, [
      { op: 'reschedule', sessionId: U(11), date: '2026-09-30', start: '14:00', end: '15:00', roomId: R2 },
      { op: 'substitute', sessionId: U(12), teacherId: T1 },
      { op: 'extra', tempId: 'make-up1', courseId: C2.id, date: '2026-10-01', start: '09:00', end: '10:00' },
    ]);
    expect(errors).toEqual([]);
    const moved = items.find((i) => i.key === U(11))!;
    expect(moved).toMatchObject({ date: '2026-09-30', start: '14:00', roomId: R2, pending: ['reschedule'] });
    expect(items.find((i) => i.key === U(12))).toMatchObject({ teacherId: T1, substitute: true });
    expect(items.find((i) => i.key === 'new:make-up1')).toMatchObject({ teacherId: T2, pending: ['extra'] });
  });

  it('refuses to touch classes that already happened, or to move into the past', () => {
    const { errors } = applyOps(base(), [
      { op: 'cancel', sessionId: U(13), reason: 'mistake' },
      { op: 'reschedule', sessionId: U(11), date: '2026-09-28', start: '07:30', end: '08:30' },
      { op: 'reschedule', sessionId: U(11), date: '2026-09-30', start: '15:00', end: '14:00' },
    ]);
    expect(errors.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it('weekly changes move this week’s untouched occurrence too, but never a one-off adjusted one', () => {
    const w = base();
    const { items } = applyOps(w, [{ op: 'slot.update', slotId: U(500), weekday: 4, start: '12:00', end: '13:00' }]);
    expect(items.find((i) => i.key === U(11))).toMatchObject({ date: '2026-10-01', start: '12:00', pending: ['weekly'] });
    w.items[0]!.adjusted = true;
    expect(applyOps(w, [{ op: 'slot.update', slotId: U(500), weekday: 4, start: '12:00', end: '13:00' }]).items.find((i) => i.key === U(11))!.date).toBe('2026-09-29');
  });

  it('validates operations strictly', () => {
    expect(DraftOps.safeParse([{ op: 'cancel', sessionId: U(1), reason: 'x' }]).success).toBe(false);
    expect(DraftOps.safeParse([{ op: 'reschedule', sessionId: U(1), date: '2026-02-30', start: '10:00', end: '11:00' }]).success).toBe(false);
    expect(DraftOps.safeParse([{ op: 'drop-table' }]).success).toBe(false);
  });
});

describe('finding clashes', () => {
  it('flags teacher and room double-booking as errors and shared students as warnings', () => {
    const w = base();
    const { items } = applyOps(w, [{ op: 'reschedule', sessionId: U(12), date: '2026-09-29', start: '10:30', end: '11:30', roomId: R1 }]);
    const c = findConflicts(items, w.courses);
    expect(c.map((x) => `${x.kind}:${x.severity}`).sort()).toEqual(['room:error', 'students:warning']);
    expect(c.find((x) => x.kind === 'students')!.message).toContain('1 student has both');
    const sub = applyOps(w, [
      { op: 'reschedule', sessionId: U(12), date: '2026-09-29', start: '10:30', end: '11:30' },
      { op: 'substitute', sessionId: U(12), teacherId: T1 },
    ]).items;
    expect(findConflicts(sub, w.courses).some((x) => x.kind === 'teacher' && x.severity === 'error')).toBe(true);
  });

  it('back-to-back classes and cancelled ones never clash', () => {
    const w = base();
    expect(findConflicts(w.items, w.courses)).toEqual([]);
    const { items } = applyOps(w, [
      { op: 'reschedule', sessionId: U(12), date: '2026-09-29', start: '10:00', end: '11:00', roomId: R1 },
      { op: 'cancel', sessionId: U(11), reason: 'teacher on leave' },
    ]);
    expect(findConflicts(items, w.courses)).toEqual([]);
  });
});

describe('drag-and-drop helpers', () => {
  it('folds repeated moves of the same class into one operation', () => {
    const it0 = base().items[0]!;
    let ops = upsertOp([], moveOp(it0, { date: '2026-09-30', start: '09:00', end: '10:00' }, 'once', [])!);
    ops = upsertOp(ops, moveOp(it0, { date: '2026-10-01', start: '09:00', end: '10:00' }, 'once', ops)!);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'reschedule', date: '2026-10-01' });
    const weekly = moveOp(it0, { date: '2026-10-02', start: '09:00', end: '10:00' }, 'weekly', ops);
    expect(weekly).toMatchObject({ op: 'slot.update', weekday: 5 });
  });

  it('moving a class added in the draft edits that class instead', () => {
    const ops = [{ op: 'extra' as const, tempId: 'x1234', courseId: C1.id, date: '2026-09-30', start: '09:00', end: '10:00' }];
    const next = moveOp({ key: 'new:x1234', sessionId: null, slotId: null, courseId: C1.id, roomId: null, mode: 'qr' }, { date: '2026-10-02', start: '15:00', end: '16:00' }, 'once', ops);
    expect(upsertOp(ops, next!)).toEqual([{ ...ops[0], date: '2026-10-02', start: '15:00', end: '16:00', roomId: null }]);
  });

  it('swaps two classes keeping each one’s length and room', () => {
    const [a, b] = base().items;
    const ops = swapOps(a!, { ...b!, end: '12:30' }, 'once', []);
    expect(ops).toEqual([
      { op: 'reschedule', sessionId: U(11), date: '2026-09-29', start: '11:00', end: '12:00', roomId: R2 },
      { op: 'reschedule', sessionId: U(12), date: '2026-09-29', start: '10:00', end: '11:30', roomId: R1 },
    ]);
  });
});
