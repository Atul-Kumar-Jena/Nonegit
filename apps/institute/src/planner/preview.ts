/**
 * What a draft would change, class by class: before → after, in plain terms. Pure (tested in Node);
 * the review sheet shows it before anything is published.
 */
import type { PlannerCourse, PlannerItem } from '@attendly/protocol';

export type ChangeKind = 'new' | 'moved' | 'cancelled' | 'removed' | 'teacher' | 'room' | 'restored';

export interface ClassChange {
  key: string;
  courseId: string;
  kinds: ChangeKind[];
  before: PlannerItem | null;
  after: PlannerItem | null;
  /** Made for every week (the weekly timetable), not just this date. */
  weekly: boolean;
}

export interface DraftPreview {
  changes: ClassChange[];
  counts: Record<ChangeKind, number>;
  /** Students whose timetable changes (each counted once). */
  students: number;
  /** Days touched, in order (YYYY-MM-DD). */
  days: string[];
}

const when = (i: PlannerItem) => `${i.date} ${i.start}-${i.end}`;

export function buildPreview(before: readonly PlannerItem[], after: readonly PlannerItem[], courses: ReadonlyMap<string, PlannerCourse>): DraftPreview {
  const was = new Map(before.map((i) => [i.key, i]));
  const now = new Map(after.map((i) => [i.key, i]));
  const changes: ClassChange[] = [];
  for (const a of after) {
    const b = was.get(a.key);
    const weekly = a.pending.includes('weekly') || a.pending.includes('slot');
    if (!b) {
      changes.push({ key: a.key, courseId: a.courseId, kinds: ['new'], before: null, after: a, weekly });
      continue;
    }
    const kinds: ChangeKind[] = [];
    if (a.status === 'cancelled' && b.status !== 'cancelled') kinds.push('cancelled');
    else if (b.status === 'cancelled' && a.status !== 'cancelled') kinds.push('restored');
    if (when(a) !== when(b)) kinds.push('moved');
    if (a.teacherId !== b.teacherId) kinds.push('teacher');
    if (a.roomId !== b.roomId) kinds.push('room');
    if (kinds.length) changes.push({ key: a.key, courseId: a.courseId, kinds, before: b, after: a, weekly });
  }
  for (const b of before) if (!now.has(b.key)) changes.push({ key: b.key, courseId: b.courseId, kinds: ['removed'], before: b, after: null, weekly: true });
  const at = (c: ClassChange) => `${(c.after ?? c.before)!.date} ${(c.after ?? c.before)!.start}`;
  changes.sort((x, y) => at(x).localeCompare(at(y)));
  const counts: Record<ChangeKind, number> = { new: 0, moved: 0, cancelled: 0, removed: 0, teacher: 0, room: 0, restored: 0 };
  for (const c of changes) for (const k of c.kinds) counts[k]++;
  const students = new Set<number>();
  for (const c of changes) for (const s of courses.get(c.courseId)?.students ?? []) students.add(s);
  const days = [...new Set(changes.flatMap((c) => [c.before?.date, c.after?.date].filter((d): d is string => !!d)))].sort();
  return { changes, counts, students: students.size, days };
}
