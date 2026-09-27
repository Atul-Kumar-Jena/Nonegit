/** Typed, signed calls to the developer (root) API. Every response is validated. */
import { z } from 'zod';
import {
  AuditPage,
  AuditVerification,
  CreatedTenant,
  IssuedSetupCode,
  FlagsResponse,
  OkResponse,
  RootConsole,
  RootMe,
  TenantDetail,
  TenantSummary,
  type AuditCategory,
  type CreateTenantBody,
  type SetFlagBody,
  type SwitchBody,
  type TenantStatusBody,
} from '@attendly/protocol';
import type { ApiClient } from '@kit/lib/api-core';

const enc = encodeURIComponent;
const qs = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '');
  return p.length ? `?${p.map(([k, v]) => `${k}=${enc(String(v))}`).join('&')}` : '';
};

export const rootApi = {
  console: (api: ApiClient) => api.authed('GET', '/v1/root/console', RootConsole),
  setSwitch: (api: ApiClient, key: string, b: SwitchBody) => api.authed('POST', `/v1/root/switches/${enc(key)}`, OkResponse, b),
  audit: (api: ApiClient, f: { before?: number; category?: AuditCategory; tenantId?: string }) => api.authed('GET', `/v1/root/audit${qs({ ...f, limit: 40 })}`, AuditPage),
  verifyAudit: (api: ApiClient) => api.authed('POST', '/v1/root/audit/verify', AuditVerification, {}),
  tenants: (api: ApiClient, q?: string) => api.authed('GET', `/v1/root/tenants${qs({ q })}`, z.array(TenantSummary)),
  tenant: (api: ApiClient, id: string) => api.authed('GET', `/v1/root/tenants/${enc(id)}`, TenantDetail),
  createTenant: (api: ApiClient, b: CreateTenantBody) => api.authed('POST', '/v1/root/tenants', CreatedTenant, b),
  /** A new one-time setup code for the main admin (first sign-in or a new phone). */
  adminSetup: (api: ApiClient, id: string) => api.authed('POST', `/v1/root/tenants/${enc(id)}/admin-setup`, IssuedSetupCode, {}),
  setTenantStatus: (api: ApiClient, id: string, b: TenantStatusBody) => api.authed('POST', `/v1/root/tenants/${enc(id)}/status`, TenantSummary, b),
  verifyTenant: (api: ApiClient, id: string, verified: boolean) => api.authed('POST', `/v1/root/tenants/${enc(id)}/verify`, TenantSummary, { verified }),
  newTenantCode: (api: ApiClient, id: string) => api.authed('POST', `/v1/root/tenants/${enc(id)}/code`, TenantSummary, {}),
  /** Emergency: end every login except developers' (one institution, or all when tenantId is null). */
  signOutEveryone: (api: ApiClient, b: { confirm: string; reason: string; tenantId: string | null }) =>
    api.authed('POST', '/v1/root/sign-out-everyone', z.object({ ok: z.boolean(), signedOut: z.number() }), b),
  flags: (api: ApiClient) => api.authed('GET', '/v1/root/flags', FlagsResponse),
  setFlag: (api: ApiClient, b: SetFlagBody) => api.authed('POST', '/v1/root/flags', OkResponse, b),
  me: (api: ApiClient) => api.authed('GET', '/v1/root/me', RootMe),
};
