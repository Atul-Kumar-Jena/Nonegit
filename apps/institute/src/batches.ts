import type { Batch } from '@attendly/protocol';

export const SEMESTERS = Array.from({ length: 10 }, (_, i) => i + 1);
/** "CSE · Semester 5" */
export const batchLine = (b: Pick<Batch, 'department' | 'semester'>) => [b.department, b.semester ? `Semester ${b.semester}` : null].filter(Boolean).join(' · ');
/** "CSE-5A · S5" for compact chips. */
export const batchChip = (b: Pick<Batch, 'name' | 'semester'>) => (b.semester ? `${b.name} · S${b.semester}` : b.name);
