import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StaffPermission } from '@attendly/protocol';
import { useApi } from '@kit/state/session';
import { staffApi } from './api';
import { localSessions } from './local-sessions';

export const qk = {
  me: ['staff', 'me'] as const,
  overview: ['staff', 'overview'] as const,
  institution: ['staff', 'institution'] as const,
  rooms: ['staff', 'rooms'] as const,
  people: (f: { role?: string; q?: string; courseId?: string }) => ['staff', 'people', f] as const,
  person: (id: string) => ['staff', 'person', id] as const,
  courses: ['staff', 'courses'] as const,
  allCourses: ['staff', 'courses', 'all'] as const,
  roster: (id: string) => ['staff', 'roster', id] as const,
  report: (id: string) => ['staff', 'report', id] as const,
  courseSessions: (id: string) => ['staff', 'course-sessions', id] as const,
  timetable: ['staff', 'timetable'] as const,
  sessions: (date: string, days: number) => ['staff', 'sessions', date, days] as const,
  session: (id: string) => ['staff', 'session', id] as const,
  feed: (id: string) => ['staff', 'feed', id] as const,
  pack: ['staff', 'offline-pack'] as const,
  flags: (status?: string) => ['staff', 'flags', status ?? 'all'] as const,
  requests: ['staff', 'device-requests'] as const,
  availability: (date: string, days: number) => ['staff', 'availability', date, days] as const,
  batches: ['staff', 'batches'] as const,
  batch: (id: string) => ['staff', 'batch', id] as const,
  planner: (week: string) => ['staff', 'planner', week] as const,
  drafts: ['staff', 'drafts'] as const,
  draft: (id: string) => ['staff', 'draft', id] as const,
  changeRequests: ['staff', 'change-requests'] as const,
  studentReport: (id: string, courseId?: string) => ['staff', 'student-report', id, courseId ?? 'all'] as const,
  matrix: (batchId?: string, courseId?: string) => ['staff', 'matrix', batchId ?? 'all', courseId ?? 'all'] as const,
  analytics: (days: number, batchId?: string, courseId?: string) => ['staff', 'analytics', days, batchId ?? 'all', courseId ?? 'all'] as const,
  punctuality: (days: number, teacherId?: string) => ['staff', 'punctuality', days, teacherId ?? 'all'] as const,
};

const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export function useMe() {
  const api = useApi();
  // Role and permissions can change any time (an admin's decision): keep them fresh.
  return useQuery({ queryKey: qk.me, queryFn: () => staffApi.me(api), staleTime: 5_000, refetchInterval: 60_000 });
}

/** True for admins. While unknown (first launch offline) staff are treated as teachers — the server enforces it anyway. */
export function useIsAdmin(): boolean {
  return useMe().data?.user.role === 'admin';
}

/** Admins can do everything; a professor what an admin granted them (server enforces the same). */
export function useCan(p: StaffPermission): boolean {
  const me = useMe().data;
  return me?.user.role === 'admin' || !!me?.permissions.includes(p);
}

export function useColleagues(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: ['staff', 'colleagues'], queryFn: () => staffApi.colleagues(api), enabled, staleTime: 60_000 });
}

/** Batches this person mentors: their students' phone requests come to them. */
export function useMentorOf(): { id: string; name: string }[] {
  return useMe().data?.mentorOf ?? [];
}

export function useOverview() {
  const api = useApi();
  const q = useQuery({ queryKey: qk.overview, queryFn: () => staffApi.overview(api), refetchInterval: 30_000 });
  useEffect(() => {
    if (q.data) void localSessions.settle(q.data.today);
  }, [q.data]);
  return q;
}

export function useInstitution() {
  const api = useApi();
  return useQuery({ queryKey: qk.institution, queryFn: () => staffApi.institution(api) });
}

export function useRooms() {
  const api = useApi();
  return useQuery({ queryKey: qk.rooms, queryFn: () => staffApi.rooms(api) });
}

export function usePeople(f: { role?: string; q?: string; courseId?: string }, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk.people(f), queryFn: () => staffApi.people(api, f), placeholderData: (prev) => prev, enabled });
}

export function usePerson(id: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.person(id), queryFn: () => staffApi.person(api, id), enabled: isId(id) });
}

export function useCourses() {
  const api = useApi();
  return useQuery({ queryKey: qk.courses, queryFn: () => staffApi.courses(api) });
}

export function useRoster(courseId: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.roster(courseId), queryFn: () => staffApi.roster(api, courseId), enabled: isId(courseId) });
}

export function useReport(courseId: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.report(courseId), queryFn: () => staffApi.report(api, courseId), enabled: isId(courseId) });
}

export function useCourseSessions(courseId: string) {
  const api = useApi();
  const q = useQuery({ queryKey: qk.courseSessions(courseId), queryFn: () => staffApi.courseSessions(api, courseId), enabled: isId(courseId) });
  useEffect(() => {
    if (q.data) void localSessions.settle(q.data);
  }, [q.data]);
  return q;
}

export function useTimetable() {
  const api = useApi();
  return useQuery({ queryKey: qk.timetable, queryFn: () => staffApi.timetable(api) });
}

export function useSessionsOn(date: string, days = 1) {
  const api = useApi();
  return useQuery({ queryKey: qk.sessions(date, days), queryFn: () => staffApi.sessions(api, { date, days }) });
}

export function useSession(id: string) {
  const api = useApi();
  const q = useQuery({ queryKey: qk.session(id), queryFn: () => staffApi.session(api, id), enabled: isId(id) });
  useEffect(() => {
    if (q.data) void localSessions.settle([q.data.session]);
  }, [q.data]);
  return q;
}

export function useFeed(id: string, live: boolean) {
  const api = useApi();
  return useQuery({ queryKey: qk.feed(id), queryFn: () => staffApi.feed(api, id), enabled: isId(id), refetchInterval: live ? 4_000 : false });
}

/** Today's and tomorrow's classes with their QR secrets and rosters — so classes run with no internet. */
export function useOfflinePack() {
  const api = useApi();
  return useQuery({ queryKey: qk.pack, queryFn: () => staffApi.offlinePack(api), refetchInterval: 10 * 60_000, staleTime: 5 * 60_000 });
}

export function useFlags(status?: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.flags(status), queryFn: () => staffApi.flags(api, status) });
}

export function useDeviceRequests() {
  const api = useApi();
  return useQuery({ queryKey: qk.requests, queryFn: () => staffApi.deviceRequests(api) });
}

export function useAvailability(date: string, days = 1, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk.availability(date, days), queryFn: () => staffApi.availability(api, date, days), enabled: enabled && /^\d{4}-\d{2}-\d{2}$/.test(date) });
}

export function useBatches() {
  const api = useApi();
  return useQuery({ queryKey: qk.batches, queryFn: () => staffApi.batches(api) });
}

export function useBatch(id: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.batch(id), queryFn: () => staffApi.batch(api, id), enabled: isId(id) });
}

export function usePlannerWeek(week: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.planner(week), queryFn: () => staffApi.plannerWeek(api, week), placeholderData: (prev) => prev, refetchInterval: 60_000 });
}

export function useDrafts() {
  const api = useApi();
  return useQuery({ queryKey: qk.drafts, queryFn: () => staffApi.drafts(api) });
}

/** Cover requests (to and from me) and students' questions to me. Refreshes every 30 s. */
export function useChangeRequests() {
  const api = useApi();
  return useQuery({ queryKey: qk.changeRequests, queryFn: () => staffApi.requests(api), refetchInterval: 30_000 });
}

/** One student's attendance per subject (any teacher or admin). */
export function useStudentReport(id: string, courseId?: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk.studentReport(id, courseId), queryFn: () => staffApi.studentReport(api, id, courseId), enabled: enabled && isId(id) });
}

/** Students × subjects for a batch and/or a subject (both optional). */
export function useMatrix(batchId?: string, courseId?: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.matrix(batchId, courseId), queryFn: () => staffApi.matrix(api, { batchId, courseId }), placeholderData: (prev) => prev });
}

/** Every subject in the institution, for picking one to add to a batch. */
export function useAllCourses(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk.allCourses, queryFn: () => staffApi.allCourses(api), enabled });
}

/** Any student of the institution by name / roll no. (not already in `notInBatch`). */
export function useStudentSearch(q: string, notInBatch?: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: ['staff', 'student-search', q, notInBatch ?? ''], queryFn: () => staffApi.searchStudents(api, q, notInBatch), enabled, placeholderData: (prev) => prev, staleTime: 30_000 });
}

export function useAnalytics(days: number, batchId?: string, courseId?: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.analytics(days, batchId, courseId), queryFn: () => staffApi.analytics(api, { days, batchId, courseId }), placeholderData: (prev) => prev, staleTime: 60_000 });
}
