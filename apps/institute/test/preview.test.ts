import { describe, expect, it } from 'vitest';
import type { PlannerCourse, PlannerItem } from '@attendly/protocol';
import { buildPreview } from '../src/planner/preview';

const item = (key: string, over: Partial<PlannerItem> = {}): PlannerItem => ({
  key,
  sessionId: key.startsWith('new:') ? null : '00000000-0000-4000-8000-000000000001',
  slotId: null,
  courseId: 'c1',
  date: '2026-09-28',
  start: '10:00',
  end: '11:00',
  roomId: 'r1',
  teacherId: 't1',
  substitute: false,
  status: 'scheduled',
  mode: 'qr',
  locked: false,
  adjusted: false,
  pending: [],
  ...over,
});
const course = (id: string, students: number[]): PlannerCourse => ({
  id,
  code: id.toUpperCase(),
  title: id,
  kind: 'theory',
  defaultMode: 'qr',
  instructorId: 't1',
  instructorName: 'Dr. T',
  batchIds: [],
  students,
  active: true,
});

describe('draft preview', () => {
  it('lists each changed class with what changed, the students affected and the days touched', () => {
    const courses = new Map([
      ['c1', course('c1', [1, 2, 3])],
      ['c2', course('c2', [3, 4])],
    ]);
    const before = [item('a'), item('b', { courseId: 'c2', start: '12:00', end: '13:00' }), item('c', { start: '14:00', end: '15:00' })];
    const after = [
      item('a', { date: '2026-09-30', start: '11:30', end: '12:30', pending: ['reschedule'] }),
      item('b', { courseId: 'c2', start: '12:00', end: '13:00', status: 'cancelled' }),
      item('c', { start: '14:00', end: '15:00' }),
      item('new:x', { courseId: 'c2', date: '2026-10-01', teacherId: 't2', roomId: 'r2' }),
    ];
    const p = buildPreview(before, after, courses);
    expect(p.changes.map((c) => [c.key, c.kinds])).toEqual([
      ['b', ['cancelled']],
      ['a', ['moved']],
      ['new:x', ['new']],
    ]);
    expect(p.counts).toMatchObject({ moved: 1, cancelled: 1, new: 1 });
    expect(p.students).toBe(4);
    expect(p.days).toEqual(['2026-09-28', '2026-09-30', '2026-10-01']);
  });

  it('spots teacher and room changes, and classes removed from the weekly timetable', () => {
    const courses = new Map([['c1', course('c1', [1])]]);
    const p = buildPreview([item('a'), item('z')], [item('a', { teacherId: 't9', roomId: 'r9' })], courses);
    expect(p.changes.find((c) => c.key === 'a')?.kinds).toEqual(['teacher', 'room']);
    expect(p.changes.find((c) => c.key === 'z')?.kinds).toEqual(['removed']);
  });
});
