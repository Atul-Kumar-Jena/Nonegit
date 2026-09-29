import { useQuery } from '@tanstack/react-query';
import { RequestsResponse, StudentTrend, SubjectDetailResponse, TimetableResponse } from '@attendly/protocol';
import { useApi } from '@kit/state/session';

export const qk = {
  dashboard: ['dashboard'] as const,
  subjects: ['subjects'] as const,
  profile: ['profile'] as const,
  timetable: ['timetable'] as const,
  subject: (id: string) => ['subject', id] as const,
  requests: ['requests'] as const,
  report: (courseId?: string) => ['report', courseId ?? 'all'] as const,
  trend: ['trend'] as const,
};

/** Week-by-week attendance (charts on Home and Subjects). */
export function useTrend() {
  const api = useApi();
  return useQuery({ queryKey: qk.trend, queryFn: () => api.authed('GET', '/v1/me/trend', StudentTrend), staleTime: 5 * 60_000 });
}

export function useDashboard() {
  const api = useApi();
  return useQuery({ queryKey: qk.dashboard, queryFn: () => api.dashboard(), refetchInterval: 30_000 });
}

export function useSubjects() {
  const api = useApi();
  return useQuery({ queryKey: qk.subjects, queryFn: () => api.subjects() });
}

export function useProfile() {
  const api = useApi();
  return useQuery({ queryKey: qk.profile, queryFn: () => api.profile() });
}

export function useTimetable() {
  const api = useApi();
  return useQuery({ queryKey: qk.timetable, queryFn: () => api.authed('GET', '/v1/me/timetable', TimetableResponse) });
}

export function useSubjectDetail(courseId: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.subject(courseId),
    queryFn: () => api.authed('GET', `/v1/me/subjects/${encodeURIComponent(courseId)}`, SubjectDetailResponse),
    enabled: /^[0-9a-f-]{36}$/i.test(courseId),
  });
}

/** My questions to teachers, with their replies. */
export function useMyRequests() {
  const api = useApi();
  return useQuery({ queryKey: qk.requests, queryFn: () => api.authed('GET', '/v1/me/requests', RequestsResponse), refetchInterval: 60_000 });
}

/** My attendance report (kept on the phone, so downloads work offline). */
export function useMyReport(courseId?: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.report(courseId), queryFn: () => api.report(courseId) });
}

/** Every student query — refreshed together after a scan or a sync. */
export const studentQueryKeys = [qk.dashboard, qk.subjects, qk.profile, qk.timetable, ['subject'], qk.requests, ['report']];
