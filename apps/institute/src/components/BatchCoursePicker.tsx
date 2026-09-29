import { useEffect, useMemo, useState } from 'react';
import type { CourseSummary } from '@attendly/protocol';
import { Field, Select } from '@/components/forms';
import { useBatches, useCourses } from '@/queries';

const NO_BATCH = '__all__';

/**
 * Scheduling starts from the batch (e.g. "CSE 2nd year · A"), then one of its subjects — the way
 * a timetable is actually planned. "All subjects" lists everything (courses not in any batch too).
 * `teacherId` narrows the subjects to one professor's (scheduling from "Who's free").
 */
export function BatchCoursePicker({
  courseId,
  onChange,
  activeOnly = false,
  teacherId = null,
}: {
  courseId: string | null;
  onChange: (courseId: string | null, course: CourseSummary | undefined) => void;
  activeOnly?: boolean;
  teacherId?: string | null;
}) {
  const courses = useCourses();
  const batches = useBatches();
  const active = useMemo(() => (batches.data ?? []).filter((b) => b.active), [batches.data]);
  const [batchId, setBatchId] = useState<string | null>(null);

  // Editing / prefilled: start from the batch that has this subject.
  useEffect(() => {
    if (batchId !== null || !courseId || !batches.data) return;
    setBatchId(active.find((b) => b.courseIds.includes(courseId))?.id ?? NO_BATCH);
  }, [courseId, batches.data, active, batchId]);

  const batch = active.find((b) => b.id === batchId);
  const options = (courses.data ?? [])
    .filter((c) => (!activeOnly || c.active) && (!teacherId || c.instructor?.id === teacherId) && (!batch || batch.courseIds.includes(c.id)))
    .map((c) => ({ value: c.id, label: `${c.code} · ${c.title}`, sub: `${c.studentCount} students${c.instructor ? ` · ${c.instructor.name}` : ' · no professor yet'}` }));

  return (
    <>
      <Field label="Batch" hint={active.length ? 'Choose the class group first; its subjects follow.' : 'No batches yet — every subject is listed.'}>
        <Select
          title="Batch"
          value={batchId}
          onChange={(v) => {
            setBatchId(v);
            const b = active.find((x) => x.id === v);
            if (courseId && b && !b.courseIds.includes(courseId)) onChange(null, undefined);
          }}
          options={[
            ...active.map((b) => ({ value: b.id, label: b.name, sub: `${b.size} students · ${b.courseIds.length} subjects${b.semester ? ` · sem ${b.semester}` : ''}` })),
            { value: NO_BATCH, label: 'All subjects', sub: 'Not limited to a batch' },
          ]}
          placeholder={batches.isPending ? 'Loading…' : 'Choose a batch'}
        />
      </Field>
      <Field label="Subject">
        <Select
          title="Subject"
          value={courseId}
          onChange={(v) => onChange(v, courses.data?.find((c) => c.id === v))}
          options={options}
          placeholder={
            courses.isPending ? 'Loading…' : batchId === null && active.length ? 'Choose the batch first' : options.length === 0 ? 'No subjects here yet' : 'Choose a subject'
          }
        />
      </Field>
    </>
  );
}
