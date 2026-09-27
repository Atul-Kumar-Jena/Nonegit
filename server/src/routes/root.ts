/**
 * Developer (root) console: platform health, kill switches, the audit log, per-institution
 * feature flags and institutions. Developer accounts only.
 *
 * A developer account from the demo institute (…@demo.attendly.app, which can sign in without a
 * code on a demo server) is a *sandbox* developer, for testing: it sees the demo institute and the
 * test institutions it added (and may add and verify more), but never a real institution, and it
 * can never flip platform switches.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_VERSION,
  AuditCategory,
  CreateTenantBody,
  type CreatedTenant,
  type IssuedSetupCode,
  SetFlagBody,
  SwitchBody,
  TenantStatusBody,
  TenantVerifyBody,
  PRESENT_CODE_ALPHABET,
  auditCategoryOf,
  keyFingerprint,
  fromB64url,
  type AuditEntry,
  type AuditPage,
  type AuditVerification,
  type FlagsResponse,
  type RootConsole,
  type RootMe,
  type TenantDetail,
  type TenantSummary,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { isUniqueViolation, withTx, type Queryable } from '../db';
import { appendAudit, verifyAuditChain } from '../lib/audit';
import { requireDevice, type AuthContext } from '../lib/auth';
import { isDemoEmail } from '../lib/demo';
import { ApiError } from '../lib/errors';
import { SWITCHES, TENANT_FLAGS, flagDefault, type SwitchKey, type TenantFlagKey } from '../lib/flags';
import { requestStats } from '../lib/metrics';
import { issueSetupCode } from '../lib/setup-codes';
import { parseServiceAccount } from '../lib/push';
import { randomBytes } from '@attendly/protocol';
import { revokeActiveDevice } from './staff-admin';

export interface RootAuth extends AuthContext {
  sandbox: boolean;
  /** null = every institution. */
  tenants: string[] | null;
  email: string | null;
  name: string;
}

export async function requireRoot(req: FastifyRequest, deps: Deps): Promise<RootAuth> {
  const auth = await requireDevice(req, deps, ['developer']);
  const { rows } = await deps.db.query<{ email: string | null; full_name: string }>('select email, full_name from users where id = $1', [auth.userId]);
  const sandbox = isDemoEmail(rows[0]?.email);
  const tenants = sandbox ? [auth.tenantId, ...(await deps.db.query<{ id: string }>('select id from tenants where sandbox and id <> $1', [auth.tenantId])).rows.map((t) => t.id)] : null;
  return { ...auth, sandbox, tenants, email: rows[0]?.email ?? null, name: rows[0]?.full_name ?? 'Developer' };
}

/** What a real (non-demo) deployment needs, and where to change it (Render → your service → Environment). */
function productionChecklist(deps: Deps): RootConsole['checklist'] {
  const c = deps.config;
  return [
    {
      key: 'email',
      label: 'Sign-in codes are emailed',
      ok: c.otpDelivery !== 'console',
      fix: 'Set OTP_DELIVERY=brevo, EMAIL_API_KEY=<your Brevo key> and SMTP_FROM="Attendly <your verified sender>" (or use resend / smtp).',
    },
    { key: 'demo', label: 'Demo sign-in is off', ok: !c.demoInstantLogin, fix: 'Set DEMO_INSTANT_LOGIN=false (it also turns off by itself once email is set up).' },
    { key: 'devtools', label: 'The /dev testing page is off', ok: !c.devToolsToken, fix: 'Delete DEV_TOOLS_TOKEN.' },
    { key: 'push', label: 'Instant notifications (Firebase)', ok: !!parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT), fix: 'Add FCM_SERVICE_ACCOUNT (Firebase service-account JSON) — see the guide.' },
    { key: 'phones', label: 'Only real phones can sign in', ok: !c.allowWebClients && !c.allowEmulators, fix: 'Delete ALLOW_WEB_CLIENTS and ALLOW_EMULATORS (or set them to false).' },
    { key: 'https', label: 'Production mode', ok: c.env === 'production', fix: 'Set NODE_ENV=production.' },
  ];
}

/** 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), unique among institutions. */
async function freshCode(db: Queryable): Promise<string> {
  for (;;) {
    const code = Array.from(randomBytes(8), (b) => PRESENT_CODE_ALPHABET[b % PRESENT_CODE_ALPHABET.length]).join('');
    const taken = await db.query('select 1 from tenants where code = $1', [code]);
    if (!taken.rowCount) return code;
  }
}

export function noSandbox(r: RootAuth, what: string) {
  if (r.sandbox) throw new ApiError(403, 'FORBIDDEN', `Sandbox developer: ${what} needs a real developer account.`);
}

/** The sandbox developer may manage its test institutions, but not the shared demo institute everyone tries. */
export function noSandboxOnDemo(r: RootAuth, id: string, what: string) {
  if (r.sandbox && id === r.tenantId) throw new ApiError(403, 'FORBIDDEN', `Sandbox developer: ${what} for the shared demo institute needs a real developer account.`);
}

/** Test institutions a sandbox developer may keep at once (the demo server is public). */
export const SANDBOX_INSTITUTION_LIMIT = 20;

const PLANNED = [
  { key: 'play_integrity_v3', label: 'Play Integrity v3', detail: 'Hardware attestation of the phone. Needs your Google Cloud project.' },
  { key: 'biometric_required', label: 'Biometric on every scan', detail: 'Face / fingerprint before each scan.' },
  { key: 'nfc_fallback', label: 'NFC fallback', detail: 'Tap a classroom NFC tag when the camera can’t scan.' },
  { key: 'ble_proximity', label: 'BLE proximity', detail: 'A Bluetooth beacon in the room instead of GPS.' },
];

export interface AuditRow {
  id: string;
  at: Date;
  action: string;
  actor: string | null;
  tenant: string | null;
  subject: string | null;
  data: Record<string, unknown>;
  hash: Buffer;
}
export const AUDIT_SELECT = `select a.id, a.at, a.action, u.full_name as actor, t.name as tenant, a.subject, a.data, a.hash
  from audit_log a left join users u on u.id = a.actor_id left join tenants t on t.id = a.tenant_id`;
export const toAuditEntry = (r: AuditRow): AuditEntry => ({
  id: Number(r.id),
  at: r.at.toISOString(),
  action: r.action,
  category: auditCategoryOf(r.action),
  actor: r.actor,
  tenant: r.tenant,
  subject: r.subject,
  data: r.data,
  hash: r.hash.toString('hex').slice(0, 16),
});

const ACTION_PREFIX: Record<Exclude<AuditCategory, 'all'>, string[]> = {
  auth: ['auth.%', 'device.%'],
  scans: ['mark.%', 'register.%', 'flag.%'],
  crypto: ['key.%', 'audit.%'],
  admin: [],
};

async function recentAudit(db: Queryable, tenants: string[] | null, limit: number): Promise<AuditEntry[]> {
  const { rows } = await db.query<AuditRow>(`${AUDIT_SELECT} where ($1::uuid[] is null or a.tenant_id = any($1)) order by a.id desc limit $2`, [tenants, limit]);
  return rows.map(toAuditEntry);
}

async function tenantSummaries(db: Queryable, tenants: string[] | null, q: string | null): Promise<TenantSummary[]> {
  const { rows } = await db.query<{
    id: string;
    slug: string;
    name: string;
    status: 'active' | 'suspended';
    status_reason: string | null;
    timezone: string;
    created_at: Date;
    students: number;
    teachers: number;
    admins: number;
    live: number;
    scans: number;
    code: string;
    verified_at: Date | null;
    sandbox: boolean;
  }>(
    `select t.id, t.slug, t.name, t.status, t.status_reason, t.timezone, t.created_at, t.code, t.verified_at, t.sandbox,
            (select count(*)::int from users u where u.tenant_id = t.id and u.role = 'student') as students,
            (select count(*)::int from users u where u.tenant_id = t.id and u.role = 'teacher') as teachers,
            (select count(*)::int from users u where u.tenant_id = t.id and u.role = 'admin') as admins,
            (select count(*)::int from class_sessions s where s.tenant_id = t.id and s.status = 'live') as live,
            (select count(*)::int from attendance_records a join class_sessions s on s.id = a.session_id
              where s.tenant_id = t.id and a.marked_at > now() - interval '24 hours') as scans
       from tenants t
      where ($1::uuid[] is null or t.id = any($1)) and ($2::text is null or t.name ilike $2 or t.slug ilike $2)
      order by t.status, t.name limit 200`,
    [tenants, q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null],
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    statusReason: r.status_reason,
    code: r.code,
    verified: r.verified_at !== null,
    verifiedAt: r.verified_at?.toISOString() ?? null,
    timezone: r.timezone,
    createdAt: r.created_at.toISOString(),
    students: r.students,
    teachers: r.teachers,
    admins: r.admins,
    liveSessions: r.live,
    scansToday: r.scans,
    demo: r.slug === 'demo' || r.sandbox,
  }));
}

export async function rootRoutes(app: FastifyInstance, deps: Deps) {
  const write = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/v1/root/console', async (req): Promise<RootConsole> => {
    const r = await requireRoot(req, deps);
    const t0 = Date.now();
    let db = true;
    try {
      await deps.db.query('select 1');
    } catch {
      db = false;
    }
    const dbLatencyMs = db ? Date.now() - t0 : null;
    const scope = r.tenants;
    const c = (
      await deps.db.query<Record<string, number>>(
        `select
          (select count(*)::int from tenants where ($1::uuid[] is null or id = any($1))) as tenants,
          (select count(*)::int from tenants where status = 'suspended' and ($1::uuid[] is null or id = any($1))) as suspended,
          (select count(*)::int from users where ($1::uuid[] is null or tenant_id = any($1))) as users,
          (select count(*)::int from users where role = 'student' and ($1::uuid[] is null or tenant_id = any($1))) as students,
          (select count(*)::int from users where role in ('teacher', 'admin') and ($1::uuid[] is null or tenant_id = any($1))) as staff,
          (select count(*)::int from devices d join users u on u.id = d.user_id where d.status = 'active' and ($1::uuid[] is null or u.tenant_id = any($1))) as devices,
          (select count(*)::int from class_sessions where status = 'live' and ($1::uuid[] is null or tenant_id = any($1))) as live,
          (select count(*)::int from attendance_records a join class_sessions s on s.id = a.session_id where a.marked_at > $2 and ($1::uuid[] is null or s.tenant_id = any($1))) as scans_min,
          (select count(*)::int from attendance_records a join class_sessions s on s.id = a.session_id where a.marked_at > $3 and ($1::uuid[] is null or s.tenant_id = any($1))) as scans_hour,
          (select count(*)::int from scan_rejections r join users u on u.id = r.user_id where r.created_at > $3 and ($1::uuid[] is null or u.tenant_id = any($1))) as rej_hour,
          (select count(*)::int from scan_rejections r join users u on u.id = r.user_id where r.created_at > $3 and r.suspicious and ($1::uuid[] is null or u.tenant_id = any($1))) as sus_hour,
          (select count(*)::int from device_requests d join users u on u.id = d.user_id where d.status = 'pending' and ($1::uuid[] is null or u.tenant_id = any($1))) as dev_req,
          (select count(*)::int from change_requests where status = 'pending' and kind = 'cover' and ($1::uuid[] is null or tenant_id = any($1))) as cover_req`,
        [scope, new Date(deps.clock() - 60_000), new Date(deps.clock() - 3_600_000)],
      )
    ).rows[0]!;
    const sw = await deps.db.query<{ key: string; enabled: boolean; reason: string | null; updated_at: Date; by: string | null }>(
      `select f.key, f.enabled, f.reason, f.updated_at, u.full_name as by from system_flags f left join users u on u.id = f.updated_by order by f.key`,
    );
    const stats = requestStats();
    return {
      sandbox: r.sandbox,
      environment: { env: deps.config.env, demoMode: deps.config.demoInstantLogin, otpDelivery: deps.config.otpDelivery, apiVersion: API_VERSION, serverKeyId: deps.signer.kid },
      checklist: productionChecklist(deps),
      health: { db, dbLatencyMs, uptimeSec: stats.uptimeSec, requests: stats.requests, errors5xx: stats.errors5xx, p50Ms: stats.p50Ms, p99Ms: stats.p99Ms },
      counts: {
        tenants: c.tenants!,
        tenantsSuspended: c.suspended!,
        users: c.users!,
        students: c.students!,
        staff: c.staff!,
        activeDevices: c.devices!,
        liveSessions: c.live!,
        scansLastMinute: c.scans_min!,
        scansLastHour: c.scans_hour!,
        rejectionsLastHour: c.rej_hour!,
        suspiciousLastHour: c.sus_hour!,
        pendingDeviceRequests: c.dev_req!,
        pendingCoverRequests: c.cover_req!,
      },
      switches: sw.rows
        .filter((s): s is typeof s & { key: SwitchKey } => s.key in SWITCHES)
        .map((s) => ({ key: s.key, label: SWITCHES[s.key].label, detail: SWITCHES[s.key].detail, enabled: s.enabled, reason: s.reason, updatedAt: s.updated_at.toISOString(), updatedBy: s.by })),
      recent: await recentAudit(deps.db, scope, 8),
    };
  });

  app.post('/v1/root/switches/:key', write, async (req) => {
    const r = await requireRoot(req, deps);
    noSandbox(r, 'changing a platform switch');
    const { key } = z.object({ key: z.enum(Object.keys(SWITCHES) as [SwitchKey, ...SwitchKey[]]) }).parse(req.params);
    const b = SwitchBody.parse(req.body);
    if (b.confirm.trim() !== key) throw new ApiError(400, 'BAD_REQUEST', `Type “${key}” to confirm.`);
    await withTx(deps.db, async (tx) => {
      // Upsert: a switch always exists once it's been flipped (never a silent no-op).
      await tx.query(
        `insert into system_flags(key, enabled, reason, updated_by, updated_at) values ($1, $2, $3, $4, $5)
         on conflict (key) do update set enabled = excluded.enabled, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [key, b.enabled, b.reason, r.userId, new Date(deps.clock())],
      );
      await appendAudit(tx, { tenantId: null, actorType: 'user', actorId: r.userId, action: 'root.switch', subject: `switch:${key}`, data: { enabled: b.enabled, reason: b.reason } });
    });
    return { ok: true };
  });

  /**
   * Emergency: sign everyone out (one institution, or all of them) — every login except developers'
   * is revoked at once; phones stay bound, so people just sign in again. Typed confirmation + reason.
   */
  app.post('/v1/root/sign-out-everyone', write, async (req) => {
    const r = await requireRoot(req, deps);
    noSandbox(r, 'signing everyone out');
    const b = z
      .object({ confirm: z.string(), reason: z.string().trim().min(3).max(200), tenantId: z.uuid().nullable().default(null) })
      .parse(req.body);
    if (b.confirm.trim() !== 'sign-out-everyone') throw new ApiError(400, 'BAD_REQUEST', 'Type “sign-out-everyone” to confirm.');
    const n = await withTx(deps.db, async (tx) => {
      const res = await tx.query(
        `update auth_sessions a set revoked_at = $1, revoke_reason = 'signed out by Attendly: ' || $2
           from users u
          where u.id = a.user_id and a.revoked_at is null and u.role <> 'developer' and ($3::uuid is null or u.tenant_id = $3)`,
        [new Date(deps.clock()), b.reason, b.tenantId],
      );
      await appendAudit(tx, { tenantId: b.tenantId, actorType: 'user', actorId: r.userId, action: 'root.sign_out_everyone', subject: b.tenantId ? `tenant:${b.tenantId}` : 'platform', data: { reason: b.reason, sessions: res.rowCount ?? 0 } });
      return res.rowCount ?? 0;
    });
    return { ok: true, signedOut: n };
  });

  app.get('/v1/root/audit', async (req): Promise<AuditPage> => {
    const r = await requireRoot(req, deps);
    const q = z
      .object({ before: z.coerce.number().int().positive().optional(), category: AuditCategory.default('all'), tenantId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(req.query);
    const tenants = q.tenantId ? (r.tenants && !r.tenants.includes(q.tenantId) ? ['00000000-0000-0000-0000-000000000000'] : [q.tenantId]) : r.tenants;
    const prefixes = q.category === 'all' ? null : ACTION_PREFIX[q.category];
    const others = Object.values(ACTION_PREFIX).flat();
    const where = `($1::uuid[] is null or a.tenant_id = any($1))
      and ($2::bigint is null or a.id < $2)
      and ($3::text[] is null or a.action like any($3))
      and (not $4 or not (a.action like any($5::text[])))`;
    const params = [tenants, q.before ?? null, prefixes && prefixes.length ? prefixes : null, q.category === 'admin', others];
    const { rows } = await deps.db.query<AuditRow>(`${AUDIT_SELECT} where ${where} order by a.id desc limit ${q.limit + 1}`, params);
    const total = (await deps.db.query<{ n: number }>(`select count(*)::int as n from audit_log a where ${where}`, [params[0], null, ...params.slice(2)])).rows[0]!.n;
    const more = rows.length > q.limit;
    const entries = rows.slice(0, q.limit).map(toAuditEntry);
    return { entries, nextBefore: more ? entries.at(-1)!.id : null, total };
  });

  app.post('/v1/root/audit/verify', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req): Promise<AuditVerification> => {
    await requireRoot(req, deps);
    const v = await verifyAuditChain(deps.db);
    return {
      ok: v.ok,
      checked: v.checked,
      message: v.ok ? `All ${v.checked} entries across ${v.chains} chains are intact.` : `The chain is broken at entry #${v.brokenAtId}: that entry (or one before it) was altered.`,
    };
  });

  app.get('/v1/root/tenants', async (req): Promise<TenantSummary[]> => {
    const r = await requireRoot(req, deps);
    const { q } = z.object({ q: z.string().trim().max(80).optional() }).parse(req.query);
    return tenantSummaries(deps.db, r.tenants, q || null);
  });

  app.get('/v1/root/tenants/:id', async (req): Promise<TenantDetail> => {
    const r = await requireRoot(req, deps);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (r.tenants && !r.tenants.includes(id)) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
    const [summary] = await tenantSummaries(deps.db, [id], null);
    if (!summary) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
    const t = (await deps.db.query<{ email_domains: string[]; min_attendance: string }>('select email_domains, min_attendance from tenants where id = $1', [id])).rows[0]!;
    const admins = await deps.db.query<{ id: string; full_name: string; email: string | null; status: string; is_owner: boolean; totp: boolean }>(
      `select id, full_name, email, status, is_owner, totp_enabled_at is not null as totp from users where tenant_id = $1 and role = 'admin' order by is_owner desc, full_name`,
      [id],
    );
    const flags = await deps.db.query<{ key: string; enabled: boolean }>('select key, enabled from tenant_flags where tenant_id = $1', [id]);
    const set = new Map(flags.rows.map((f) => [f.key, f.enabled]));
    return {
      ...summary,
      emailDomains: t.email_domains,
      minAttendance: Number(t.min_attendance),
      admins: admins.rows.map((a) => ({ id: a.id, name: a.full_name, email: a.email, status: a.status, owner: a.is_owner, authenticator: a.totp })),
      flags: Object.keys(TENANT_FLAGS).map((key) => ({ key, enabled: set.get(key) ?? flagDefault(key as TenantFlagKey, deps.config) })),
      recent: await recentAudit(deps.db, [id], 10),
    };
  });

  /** Onboard a new institution: it starts empty with its first admin, who sets up the rest. */
  app.post('/v1/root/tenants', write, async (req): Promise<CreatedTenant> => {
    const r = await requireRoot(req, deps);
    const b = CreateTenantBody.parse(req.body);
    try {
      const id = await withTx(deps.db, async (tx) => {
        if (r.sandbox) {
          await tx.query(`select pg_advisory_xact_lock(hashtext('sandbox-institutions'))`);
          const n = (await tx.query<{ n: number }>('select count(*)::int as n from tenants where sandbox')).rows[0]!.n;
          if (n >= SANDBOX_INSTITUTION_LIMIT)
            throw new ApiError(409, 'CONFLICT', `The demo server already holds ${SANDBOX_INSTITUTION_LIMIT} test institutions. Suspend or reuse one, or sign in with a real developer account.`);
        }
        const tz = await tx.query('select 1 from pg_timezone_names where name = $1', [b.timezone]);
        if (tz.rowCount !== 1) throw new ApiError(400, 'BAD_REQUEST', `“${b.timezone}” isn’t a time zone. Use a name like Asia/Kolkata.`);
        const base = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'institution';
        const taken = await tx.query('select 1 from tenants where slug = $1', [base]);
        const slug = taken.rowCount ? `${base}-${Array.from(randomBytes(2), (x) => x.toString(16).padStart(2, '0')).join('')}` : base;
        const t = await tx.query<{ id: string }>(
          `insert into tenants(slug, name, email_domains, timezone, min_attendance, term_name, term_start, code, verified_at, sandbox)
           values ($1, $2, $3, $4, $5, 'Current term', (now() at time zone $4)::date, $6, null, $7) returning id`,
          [slug, b.name, [b.adminEmail.split('@')[1]!], b.timezone, b.minAttendance, await freshCode(tx), r.sandbox],
        );
        const tenantId = t.rows[0]!.id;
        const admin = await tx.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email, created_by, is_owner) values ($1, 'admin', $2, $3, $4, true) returning id`, [
          tenantId,
          b.adminName,
          b.adminEmail,
          r.userId,
        ]);
        // The main admin signs in the first time with this code and Google Authenticator (no email needed).
        const setup = await issueSetupCode(tx, deps.hash, admin.rows[0]!.id, deps.clock());
        await appendAudit(tx, { tenantId, actorType: 'user', actorId: r.userId, action: 'institution.create', subject: `user:${admin.rows[0]!.id}`, data: { slug } });
        await appendAudit(tx, { tenantId: null, actorType: 'user', actorId: r.userId, action: 'root.tenant_create', subject: `tenant:${tenantId}`, data: { slug, name: b.name, sandbox: r.sandbox } });
        return { tenantId, setup };
      });
      const summary = (await tenantSummaries(deps.db, [id.tenantId], null))[0]!;
      return { ...summary, adminSetup: { name: b.adminName, signInId: b.adminEmail, code: id.setup.code, expiresAt: id.setup.expiresAt.toISOString() } };
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) throw new ApiError(409, 'CONFLICT', 'That email already belongs to an account. Use a different admin email.');
      throw err;
    }
  });

  app.post('/v1/root/tenants/:id/status', write, async (req): Promise<TenantSummary> => {
    const r = await requireRoot(req, deps);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = TenantStatusBody.parse(req.body);
    if (r.tenants && !r.tenants.includes(id)) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
    if (id === r.tenantId && b.status === 'suspended') throw new ApiError(409, 'CONFLICT', 'You can’t suspend your own institution — you would lock yourself out.');
    await withTx(deps.db, async (tx) => {
      const t = (await tx.query<{ slug: string; status: string }>('select slug, status from tenants where id = $1 for update', [id])).rows[0];
      if (!t) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
      if (b.confirm.trim() !== t.slug) throw new ApiError(400, 'BAD_REQUEST', `Type “${t.slug}” to confirm.`);
      await tx.query('update tenants set status = $2, status_reason = $3 where id = $1', [id, b.status, b.status === 'suspended' ? b.reason : null]);
      if (b.status === 'suspended')
        await tx.query(
          `update auth_sessions a set revoked_at = $2, revoke_reason = 'institution suspended' from users u where u.id = a.user_id and u.tenant_id = $1 and a.revoked_at is null`,
          [id, new Date(deps.clock())],
        );
      await appendAudit(tx, { tenantId: id, actorType: 'user', actorId: r.userId, action: `institution.${b.status === 'suspended' ? 'suspend' : 'resume'}`, subject: `tenant:${id}`, data: { reason: b.reason } });
      await appendAudit(tx, { tenantId: null, actorType: 'user', actorId: r.userId, action: 'root.tenant_status', subject: `tenant:${id}`, data: { status: b.status, reason: b.reason } });
    });
    return (await tenantSummaries(deps.db, [id], null))[0]!;
  });

  /** The verified mark: until it is set nobody can sign in to the institution (developers aside). */
  app.post('/v1/root/tenants/:id/verify', write, async (req): Promise<TenantSummary> => {
    const r = await requireRoot(req, deps);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = TenantVerifyBody.parse(req.body);
    if (r.tenants && !r.tenants.includes(id)) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
    if (!b.verified) noSandboxOnDemo(r, id, 'removing the verification');
    await withTx(deps.db, async (tx) => {
      const t = await tx.query('select 1 from tenants where id = $1 for update', [id]);
      if (!t.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
      await tx.query('update tenants set verified_at = $2, verified_by = $3 where id = $1', [id, b.verified ? new Date(deps.clock()) : null, b.verified ? r.userId : null]);
      await appendAudit(tx, { tenantId: id, actorType: 'user', actorId: r.userId, action: b.verified ? 'institution.verify' : 'institution.unverify', subject: `tenant:${id}` });
      await appendAudit(tx, { tenantId: null, actorType: 'user', actorId: r.userId, action: 'root.tenant_verify', subject: `tenant:${id}`, data: { verified: b.verified } });
    });
    return (await tenantSummaries(deps.db, [id], null))[0]!;
  });

  /**
   * A new setup code for the institution's main admin (first sign-in, or a new phone): the old code and
   * the old phone stop working; they link Google Authenticator again with the new code.
   */
  app.post('/v1/root/tenants/:id/admin-setup', write, async (req): Promise<IssuedSetupCode> => {
    const r = await requireRoot(req, deps);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (r.tenants && !r.tenants.includes(id)) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
    noSandboxOnDemo(r, id, 'a new main-admin setup code');
    return withTx(deps.db, async (tx) => {
      const o = (await tx.query<{ id: string; full_name: string; email: string | null; phone: string | null }>(`select id, full_name, email, phone from users where tenant_id = $1 and is_owner for update`, [id])).rows[0];
      if (!o) throw new ApiError(404, 'NOT_FOUND', 'This institution has no main admin.');
      const setup = await issueSetupCode(tx, deps.hash, o.id, deps.clock());
      await revokeActiveDevice(tx, o.id, 'new main-admin setup code', new Date(deps.clock()));
      await appendAudit(tx, { tenantId: id, actorType: 'user', actorId: r.userId, action: 'institution.owner_setup_code', subject: `user:${o.id}` });
      await appendAudit(tx, { tenantId: null, actorType: 'user', actorId: r.userId, action: 'root.owner_setup_code', subject: `tenant:${id}` });
      return { name: o.full_name, signInId: o.email ?? o.phone ?? '', code: setup.code, expiresAt: setup.expiresAt.toISOString() };
    });
  });

  /** A new institution code (e.g. the old one was shared too widely). Signed-in people are unaffected. */
  app.post('/v1/root/tenants/:id/code', write, async (req): Promise<TenantSummary> => {
    const r = await requireRoot(req, deps);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    noSandboxOnDemo(r, id, 'changing the code');
    if (r.tenants && !r.tenants.includes(id)) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
    await withTx(deps.db, async (tx) => {
      const res = await tx.query('update tenants set code = $2 where id = $1', [id, await freshCode(tx)]);
      if (!res.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
      await appendAudit(tx, { tenantId: null, actorType: 'user', actorId: r.userId, action: 'root.tenant_code', subject: `tenant:${id}` });
    });
    return (await tenantSummaries(deps.db, [id], null))[0]!;
  });

  app.get('/v1/root/flags', async (req): Promise<FlagsResponse> => {
    const r = await requireRoot(req, deps);
    const tenants = await deps.db.query<{ id: string; name: string }>(`select id, name from tenants where ($1::uuid[] is null or id = any($1)) order by name`, [r.tenants]);
    const set = await deps.db.query<{ tenant_id: string; key: string; enabled: boolean }>(
      `select tenant_id, key, enabled from tenant_flags where ($1::uuid[] is null or tenant_id = any($1))`,
      [r.tenants],
    );
    const byTenant = new Map<string, Map<string, boolean>>();
    for (const f of set.rows) byTenant.set(f.tenant_id, (byTenant.get(f.tenant_id) ?? new Map()).set(f.key, f.enabled));
    return {
      definitions: Object.entries(TENANT_FLAGS).map(([key, d]) => ({ key, label: d.label, detail: d.detail, default: flagDefault(key as TenantFlagKey, deps.config), enforced: true })),
      planned: PLANNED,
      tenants: tenants.rows.map((t) => ({
        id: t.id,
        name: t.name,
        flags: Object.fromEntries(Object.keys(TENANT_FLAGS).map((key) => [key, byTenant.get(t.id)?.get(key) ?? flagDefault(key as TenantFlagKey, deps.config)])),
      })),
    };
  });

  app.post('/v1/root/flags', write, async (req) => {
    const r = await requireRoot(req, deps);
    const b = SetFlagBody.parse(req.body);
    if (r.tenants && !r.tenants.includes(b.tenantId)) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
    await withTx(deps.db, async (tx) => {
      const t = await tx.query('select 1 from tenants where id = $1', [b.tenantId]);
      if (!t.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
      await tx.query(
        `insert into tenant_flags(tenant_id, key, enabled, updated_by, updated_at) values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, key) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [b.tenantId, b.key, b.enabled, r.userId, new Date(deps.clock())],
      );
      await appendAudit(tx, { tenantId: b.tenantId, actorType: 'user', actorId: r.userId, action: 'root.flag', subject: `flag:${b.key}`, data: { enabled: b.enabled } });
    });
    return { ok: true };
  });

  app.get('/v1/root/me', async (req): Promise<RootMe> => {
    const r = await requireRoot(req, deps);
    const inst = (await deps.db.query<{ name: string }>('select name from tenants where id = $1', [r.tenantId])).rows[0]!;
    const devices = await deps.db.query<{ model: string | null; platform: string; fingerprint: string; bound_at: Date | null; last_seen_at: Date | null; status: string }>(
      `select model, platform, fingerprint, bound_at, last_seen_at, status from devices where user_id = $1 order by bound_at desc nulls last limit 10`,
      [r.userId],
    );
    return {
      user: { id: r.userId, name: r.name, email: r.email },
      institution: inst.name,
      sandbox: r.sandbox,
      devices: devices.rows.map((d) => ({ model: d.model, platform: d.platform, fingerprint: d.fingerprint, boundAt: d.bound_at?.toISOString() ?? null, lastSeenAt: d.last_seen_at?.toISOString() ?? null, status: d.status })),
      serverKey: { kid: deps.signer.kid, publicKey: keyFingerprint(fromB64url(deps.signer.publicKeyB64)) },
      environment: { env: deps.config.env, demoMode: deps.config.demoInstantLogin, otpDelivery: deps.config.otpDelivery, webClients: deps.config.allowWebClients, emulators: deps.config.allowEmulators },
    };
  });
}
