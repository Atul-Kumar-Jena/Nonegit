import { useQuery } from '@tanstack/react-query';
import { useApi } from './session';

export const qk = {
  dashboard: ['dashboard'] as const,
  subjects: ['subjects'] as const,
  profile: ['profile'] as const,
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
