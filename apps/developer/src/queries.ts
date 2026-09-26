import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AuditCategory } from '@attendly/protocol';
import { useApi } from '@kit/state/session';
import { rootApi } from './api';

export const qk = {
  console: ['root', 'console'] as const,
  audit: (category: AuditCategory, tenantId?: string) => ['root', 'audit', category, tenantId ?? 'all'] as const,
  tenants: (q: string) => ['root', 'tenants', q] as const,
  tenant: (id: string) => ['root', 'tenant', id] as const,
  flags: ['root', 'flags'] as const,
  me: ['root', 'me'] as const,
};

export function useConsole() {
  const api = useApi();
  return useQuery({ queryKey: qk.console, queryFn: () => rootApi.console(api), refetchInterval: 10_000 });
}

export function useAudit(category: AuditCategory, tenantId?: string) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: qk.audit(category, tenantId),
    queryFn: ({ pageParam }) => rootApi.audit(api, { category, tenantId, before: pageParam ?? undefined }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
  });
}

export function useTenants(q: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.tenants(q), queryFn: () => rootApi.tenants(api, q || undefined) });
}

export function useTenant(id: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.tenant(id), queryFn: () => rootApi.tenant(api, id), enabled: /^[0-9a-f-]{36}$/i.test(id) });
}

export function useFlags() {
  const api = useApi();
  return useQuery({ queryKey: qk.flags, queryFn: () => rootApi.flags(api) });
}

export function useRootMe() {
  const api = useApi();
  return useQuery({ queryKey: qk.me, queryFn: () => rootApi.me(api), staleTime: 60_000 });
}
