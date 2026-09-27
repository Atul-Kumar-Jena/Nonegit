/**
 * Developer (root) console contract: platform health, kill switches, the audit log,
 * per-institution feature flags and institution (tenant) management.
 */
import { z } from 'zod';
import { IsoDate } from './schemas';

const uuid = z.uuid();

export const AUDIT_CATEGORIES = ['all', 'auth', 'scans', 'admin', 'crypto'] as const;
export const AuditCategory = z.enum(AUDIT_CATEGORIES);
export type AuditCategory = z.infer<typeof AuditCategory>;

/** Which filter an audit action belongs to. */
export function auditCategoryOf(action: string): Exclude<AuditCategory, 'all'> {
  if (action.startsWith('auth.') || action.startsWith('device.')) return 'auth';
  if (action.startsWith('mark.') || action.startsWith('register.') || action.startsWith('flag.')) return 'scans';
  if (action.startsWith('key.') || action.startsWith('audit.')) return 'crypto';
  return 'admin';
}

export const AuditEntry = z.object({
  id: z.number().int(),
  at: IsoDate,
  action: z.string(),
  category: AuditCategory,
  actor: z.string().nullable(),
  tenant: z.string().nullable(),
  subject: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditPage = z.object({ entries: z.array(AuditEntry), nextBefore: z.number().int().nullable(), total: z.number().int() });
export type AuditPage = z.infer<typeof AuditPage>;

export const AuditVerification = z.object({ ok: z.boolean(), checked: z.number().int(), message: z.string() });
export type AuditVerification = z.infer<typeof AuditVerification>;

export const SwitchState = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string(),
  enabled: z.boolean(),
  reason: z.string().nullable(),
  updatedAt: IsoDate,
  updatedBy: z.string().nullable(),
});
export type SwitchState = z.infer<typeof SwitchState>;

export const RootConsole = z.object({
  /** A demo "sandbox" developer: sees only the demo institute and can't flip platform switches. */
  sandbox: z.boolean(),
  environment: z.object({ env: z.string(), demoMode: z.boolean(), otpDelivery: z.string(), apiVersion: z.number().int(), serverKeyId: z.string() }),
  health: z.object({
    db: z.boolean(),
    dbLatencyMs: z.number().nullable(),
    uptimeSec: z.number().int(),
    requests: z.number().int(),
    errors5xx: z.number().int(),
    p50Ms: z.number().nullable(),
    p99Ms: z.number().nullable(),
  }),
  counts: z.object({
    tenants: z.number().int(),
    tenantsSuspended: z.number().int(),
    users: z.number().int(),
    students: z.number().int(),
    staff: z.number().int(),
    activeDevices: z.number().int(),
    liveSessions: z.number().int(),
    scansLastMinute: z.number().int(),
    scansLastHour: z.number().int(),
    rejectionsLastHour: z.number().int(),
    suspiciousLastHour: z.number().int(),
    pendingDeviceRequests: z.number().int(),
    pendingCoverRequests: z.number().int(),
  }),
  switches: z.array(SwitchState),
  recent: z.array(AuditEntry),
});
export type RootConsole = z.infer<typeof RootConsole>;

export const SwitchBody = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3, 'Say why (it goes in the audit log)').max(300),
  /** Typed confirmation: the switch's key. */
  confirm: z.string(),
});
export type SwitchBody = z.infer<typeof SwitchBody>;

export const TenantSummary = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  status: z.enum(['active', 'suspended']),
  statusReason: z.string().nullable(),
  timezone: z.string(),
  createdAt: IsoDate,
  students: z.number().int(),
  teachers: z.number().int(),
  admins: z.number().int(),
  liveSessions: z.number().int(),
  scansToday: z.number().int(),
  demo: z.boolean(),
  /** Typed once in the Institute app, e.g. "7F3A91C2" (shown as 7F3A-91C2). */
  code: z.string().default(''),
  /** Set by an Attendly developer; until then nobody can sign in. */
  verified: z.boolean().default(true),
  verifiedAt: IsoDate.nullable().default(null),
});
export type TenantSummary = z.infer<typeof TenantSummary>;

export const TenantFlagKey = z.enum(['strict_geo', 'student_requests', 'manual_registers']);
export type TenantFlagKey = z.infer<typeof TenantFlagKey>;

export const FlagDefinition = z.object({ key: z.string(), label: z.string(), detail: z.string(), default: z.boolean(), enforced: z.boolean() });
export type FlagDefinition = z.infer<typeof FlagDefinition>;

export const TenantDetail = TenantSummary.extend({
  emailDomains: z.array(z.string()),
  minAttendance: z.number(),
  admins: z.array(z.object({ id: uuid, name: z.string(), email: z.string().nullable(), status: z.string() })),
  flags: z.array(z.object({ key: z.string(), enabled: z.boolean() })),
  recent: z.array(AuditEntry),
});
export type TenantDetail = z.infer<typeof TenantDetail>;

export const CreateTenantBody = z.object({
  name: z.string().trim().min(2).max(120),
  adminName: z.string().trim().min(1).max(120),
  adminEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  timezone: z.string().trim().min(1).max(60).default('Asia/Kolkata'),
  minAttendance: z.number().min(0).max(100).default(75),
});
export type CreateTenantBody = z.infer<typeof CreateTenantBody>;

export const TenantStatusBody = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(3, 'Say why (the institution’s admins can be told)').max(300),
  /** Typed confirmation: the institution's slug. */
  confirm: z.string(),
});
export type TenantStatusBody = z.infer<typeof TenantStatusBody>;

export const TenantVerifyBody = z.object({ verified: z.boolean() });
export type TenantVerifyBody = z.infer<typeof TenantVerifyBody>;

export const FlagsResponse = z.object({
  definitions: z.array(FlagDefinition),
  /** Shown for the roadmap only — nothing to switch yet. */
  planned: z.array(z.object({ key: z.string(), label: z.string(), detail: z.string() })),
  tenants: z.array(z.object({ id: uuid, name: z.string(), flags: z.record(z.string(), z.boolean()) })),
});
export type FlagsResponse = z.infer<typeof FlagsResponse>;

export const SetFlagBody = z.object({ tenantId: uuid, key: TenantFlagKey, enabled: z.boolean() });
export type SetFlagBody = z.infer<typeof SetFlagBody>;

export const RootMe = z.object({
  user: z.object({ id: uuid, name: z.string(), email: z.string().nullable() }),
  institution: z.string(),
  sandbox: z.boolean(),
  devices: z.array(z.object({ model: z.string().nullable(), platform: z.string(), fingerprint: z.string(), boundAt: IsoDate.nullable(), lastSeenAt: IsoDate.nullable(), status: z.string() })),
  serverKey: z.object({ kid: z.string(), publicKey: z.string() }),
  environment: z.object({ env: z.string(), demoMode: z.boolean(), otpDelivery: z.string(), webClients: z.boolean(), emulators: z.boolean() }),
});
export type RootMe = z.infer<typeof RootMe>;
