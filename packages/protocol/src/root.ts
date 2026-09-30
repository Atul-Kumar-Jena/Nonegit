/**
 * Developer (root) console contract: platform health, kill switches, the audit log,
 * per-institution feature flags and institution (tenant) management.
 */
import { z } from 'zod';
import { IsoDate, IssuedSetupCode } from './schemas';
import { Person } from './staff';

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
  /** Is this server set up for real use? One line per setting, with how to fix it. */
  checklist: z.array(z.object({ key: z.string(), label: z.string(), ok: z.boolean(), fix: z.string() })).default([]),
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
  /** Instant notifications: is the server connected to Firebase, how many phones can receive, and what happened. */
  push: z
    .object({
      configured: z.boolean(),
      project: z.string().nullable(),
      phones: z.number().int(),
      sent: z.number().int(),
      failed: z.number().int(),
      deadTokens: z.number().int(),
      lastSentAt: z.string().nullable(),
      lastError: z.string().nullable(),
      lastErrorAt: z.string().nullable(),
      /** Each app on its own: which Firebase project sends its notifications and how many of its phones can receive. */
      apps: z
        .array(z.object({ app: z.enum(['student', 'institute']), configured: z.boolean(), project: z.string().nullable(), phones: z.number().int(), variable: z.string() }))
        .default([]),
    })
    .nullable()
    .default(null),
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

export const TenantFlagKey = z.enum(['strict_geo', 'student_requests', 'manual_registers', 'offline_scans_off']);
export type TenantFlagKey = z.infer<typeof TenantFlagKey>;

export const FlagDefinition = z.object({ key: z.string(), label: z.string(), detail: z.string(), default: z.boolean(), enforced: z.boolean() });
export type FlagDefinition = z.infer<typeof FlagDefinition>;

export const TenantDetail = TenantSummary.extend({
  emailDomains: z.array(z.string()),
  minAttendance: z.number(),
  admins: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      email: z.string().nullable(),
      status: z.string(),
      /** The main admin (adds and manages the other admins). */
      owner: z.boolean().default(false),
      /** Linked Google Authenticator (has signed in with a setup code). */
      authenticator: z.boolean().default(false),
    }),
  ),
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

/** A new institution, with its main admin's one-time setup code (shown once — share it privately). */
export const CreatedTenant = TenantSummary.extend({ adminSetup: IssuedSetupCode });
export type CreatedTenant = z.infer<typeof CreatedTenant>;

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

// ── Support: the developer opens an institution and manages its people ──
// Every action is recorded on the institution's and the platform's audit chains under the
// developer's own account. "as" only chooses what the institution's people are shown as the author
// in their notifications: the developer's name, or "Attendly support".
export const SupportAttribution = z.enum(['named', 'support']);
export type SupportAttribution = z.infer<typeof SupportAttribution>;
export const SupportAction = z.enum(['suspend', 'reactivate', 'reset_phone', 'setup_code', 'make_admin', 'make_professor', 'make_owner']);
export type SupportAction = z.infer<typeof SupportAction>;
export const SupportActionBody = z.object({ action: SupportAction, as: SupportAttribution, reason: z.string().trim().min(3).max(200) });
export type SupportActionBody = z.infer<typeof SupportActionBody>;
export const SupportPerson = z.object({
  person: Person,
  /** Students: classes attended of those held in their subjects. */
  attendance: z.object({ attended: z.number().int(), held: z.number().int(), percent: z.number().nullable() }).nullable(),
  /** What happened to or by this account, newest first. */
  history: z.array(AuditEntry),
});
export type SupportPerson = z.infer<typeof SupportPerson>;
export const SupportActionResult = z.object({ person: Person, setup: IssuedSetupCode.nullable(), message: z.string() });
export type SupportActionResult = z.infer<typeof SupportActionResult>;

// ── Broadcasts: a notice from Attendly to many institutions at once ──
export const BroadcastAudience = z.enum(['everyone', 'students', 'admins', 'staff']);
export type BroadcastAudience = z.infer<typeof BroadcastAudience>;
export const BroadcastTarget = z.object({
  audience: BroadcastAudience,
  /** null: every active, verified institution. */
  tenantId: uuid.nullable().default(null),
});
export type BroadcastTarget = z.infer<typeof BroadcastTarget>;
export const BroadcastBody = BroadcastTarget.extend({
  title: z.string().trim().min(1, 'Add a title').max(120),
  body: z.string().trim().min(1, 'Write the message').max(5000),
  category: z.enum(['general', 'academic', 'exam', 'event', 'holiday']).default('general'),
  important: z.boolean().default(false),
  pinned: z.boolean().default(false),
  /** Signed as "Attendly" or with the developer's name (always recorded under their account). */
  as: SupportAttribution.default('support'),
});
export type BroadcastBody = z.input<typeof BroadcastBody>;
export const BroadcastPreview = z.object({ institutions: z.number().int(), recipients: z.number().int(), label: z.string() });
export type BroadcastPreview = z.infer<typeof BroadcastPreview>;
export const BroadcastSummary = z.object({
  id: uuid,
  title: z.string(),
  audienceLabel: z.string(),
  signedAs: z.string(),
  institutions: z.number().int(),
  recipients: z.number().int(),
  seen: z.number().int(),
  important: z.boolean(),
  createdAt: IsoDate,
});
export type BroadcastSummary = z.infer<typeof BroadcastSummary>;
