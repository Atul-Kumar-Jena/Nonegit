import { useQuery } from '@tanstack/react-query';
import { SubjectDetailResponse, TimetableResponse } from '@attendly/protocol';
import { useApi } from '@kit/state/session';

export const qk = {
  dashboard: ['dashboard'] as const,
  subjects: ['subjects'] as const,
  profile: ['profile'] as const,
  timetable: ['timetable'] as const,
  subject: (id: string) => ['subject', id] as const,
};

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

/** Every student query — refreshed together after a scan or a sync. */
export const studentQueryKeys = [qk.dashboard, qk.subjects, qk.profile, qk.timetable, ['subject']];
