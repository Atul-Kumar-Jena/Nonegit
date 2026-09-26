import { useEffect, useState } from 'react';
import { vault } from '@kit/lib/vault';
import { useCourses, useIsAdmin, usePeople, useRooms, useTimetable } from './queries';

const REVIEWED_KEY = 'setup.institution-reviewed.v1';
let reviewed: boolean | null = null;
const listeners = new Set<(v: boolean) => void>();

export async function markInstitutionReviewed() {
  reviewed = true;
  for (const l of listeners) l(true);
  await vault.set(REVIEWED_KEY, true).catch(() => undefined);
}

function useInstitutionReviewed(): boolean {
  const [v, setV] = useState(reviewed ?? false);
  useEffect(() => {
    listeners.add(setV);
    if (reviewed === null)
      void vault.get<boolean>(REVIEWED_KEY, (x) => x === true).then((x) => {
        reviewed = x === true;
        setV(reviewed);
      });
    return () => void listeners.delete(setV);
  }, []);
  return v;
}

export interface SetupStep {
  key: string;
  title: string;
  why: string;
  done: boolean;
  href: string;
  optional?: boolean;
}

/** The onboarding checklist, computed from what actually exists on the server. */
export function useSetupProgress() {
  const admin = useIsAdmin();
  const rooms = useRooms();
  const courses = useCourses();
  const teachers = usePeople({ role: 'teacher' });
  const students = usePeople({ role: 'student' });
  const slots = useTimetable();
  const inst = useInstitutionReviewed();

  const loaded = !!(rooms.data && courses.data && teachers.data && students.data && slots.data);
  const steps: SetupStep[] = [
    { key: 'institution', title: 'Check institution settings', why: 'Name, time zone, term start date and the minimum attendance %.', done: inst, href: '/institution' },
    { key: 'rooms', title: 'Add classrooms', why: 'Save each room’s location once, so QR classes know where students must be.', done: !!rooms.data?.some((r) => r.lat !== null), href: '/rooms' },
    { key: 'teachers', title: 'Add teachers', why: 'Each teacher signs in with their own email and runs their own classes.', done: (teachers.data?.length ?? 0) > 0, href: '/people?role=teacher', optional: true },
    { key: 'courses', title: 'Create courses', why: 'A course is a subject (e.g. CS-301) with one teacher.', done: (courses.data?.length ?? 0) > 0, href: '/course-form' },
    { key: 'students', title: 'Add students', why: 'Paste a list from a spreadsheet: name, roll no., email.', done: (students.data?.length ?? 0) > 0, href: '/import' },
    { key: 'enrol', title: 'Put students in courses', why: 'Only enrolled students can be marked in a course.', done: !!courses.data?.some((c) => c.studentCount > 0), href: '/classes' },
    { key: 'timetable', title: 'Build the timetable', why: 'Weekly slots create every class automatically, for every app.', done: (slots.data?.length ?? 0) > 0, href: '/slot-form' },
  ];
  const required = steps.filter((s) => !s.optional);
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.title ?? 'All done';
  return { admin, loaded, steps, done, total: steps.length, next, incomplete: loaded && required.some((s) => !s.done) };
}
