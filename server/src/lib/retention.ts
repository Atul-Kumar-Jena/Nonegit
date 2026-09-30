/**
 * Data lifecycle: what Attendly keeps, and for how long.
 *
 * KEPT FOR GOOD — the institution's records: people, batches, courses, the timetable, every class
 * (held, missed or cancelled), attendance records and credits, devices, and the tamper-evident audit
 * log. Percentages, reports and disputes depend on them, so nothing here ever deletes them.
 *
 * TRIMMED — working data that only matters for a while (below). The janitor runs these rules about
 * once an hour, on one server at a time, in small batches with a pause in between, so a big clean-up
 * never locks a table or slows the app down.
 */
import type { PoolClient } from 'pg';
import type { Db } from '../db';

const DAY = 86_400_000;

export interface RetentionRule {
  /** Stable key (shown in the Developer console). */
  key: string;
  /** What it is and how long it stays, in plain words. */
  label: string;
  table: string;
  /** Rows to remove: a condition with $1 = now (timestamptz). */
  where: string;
}

export const RETENTION_RULES: RetentionRule[] = [
  // ── security plumbing: useless once expired ──
  { key: 'nonces', label: 'Replay-protection nonces · until they expire', table: 'request_nonces', where: 'expires_at < $1::timestamptz' },
  { key: 'attest', label: 'Phone-chip challenges · until they expire', table: 'attest_challenges', where: 'expires_at < $1::timestamptz' },
  { key: 'otp', label: 'Sign-in codes · 1 day', table: 'otp_challenges', where: `created_at < $1::timestamptz - interval '1 day'` },
  { key: 'tickets', label: 'Phone-binding tickets · 1 day after expiry', table: 'auth_tickets', where: `expires_at < $1::timestamptz - interval '1 day'` },
  { key: 'logins', label: 'Expired logins · 1 day after expiry', table: 'auth_sessions', where: `refresh_expires_at < $1::timestamptz - interval '1 day'` },
  // Every 15-minute token refresh leaves the old token behind (for spotting a stolen one being reused).
  // A week is plenty for that: an older copy is simply unknown and refused.
  { key: 'rotated', label: 'Replaced login tokens · 7 days', table: 'auth_sessions', where: `rotated_at < $1::timestamptz - interval '7 days'` },
  { key: 'revoked', label: 'Signed-out logins · 30 days', table: 'auth_sessions', where: `revoked_at < $1::timestamptz - interval '30 days'` },
  { key: 'online', label: 'Online-evidence minutes (offline-scan checks) · 2 days', table: 'device_online', where: `minute < $1::timestamptz - interval '2 days'` },
  { key: 'pairings', label: 'Big-screen pairings · 7 days after they end', table: 'present_pairings', where: `coalesce(revoked_at, expires_at) < $1::timestamptz - interval '7 days'` },
  { key: 'actions', label: 'Offline-upload receipts (no double counting) · 30 days', table: 'client_actions', where: `created_at < $1::timestamptz - interval '30 days'` },
  {
    key: 'push',
    label: 'Push addresses of signed-out phones, or not refreshed in 120 days',
    table: 'push_tokens',
    where: `updated_at < $1::timestamptz - interval '120 days' or device_id in (select id from devices where status = 'revoked')`,
  },
  // ── history people look at for a while ──
  { key: 'notif-read', label: 'Read notifications · 6 months', table: 'notifications', where: `read_at is not null and created_at < $1::timestamptz - interval '180 days'` },
  { key: 'notif-old', label: 'Unread notifications · 1 year', table: 'notifications', where: `created_at < $1::timestamptz - interval '365 days'` },
  { key: 'refusals', label: 'Reviewed scan refusals · 1 year (open ones stay until reviewed)', table: 'scan_rejections', where: `review_status <> 'open' and created_at < $1::timestamptz - interval '365 days'` },
  {
    key: 'rounds',
    label: 'Per-round scans of multi-scan classes · 120 days (the chain head stays on the record)',
    table: 'scan_round_marks',
    where: `marked_at < $1::timestamptz - interval '120 days'`,
  },
  { key: 'requests', label: 'Answered class requests · 6 months', table: 'change_requests', where: `status <> 'pending' and created_at < $1::timestamptz - interval '180 days'` },
  { key: 'phone-requests', label: 'Decided phone requests · 1 year', table: 'device_requests', where: `status <> 'pending' and created_at < $1::timestamptz - interval '365 days'` },
  { key: 'notices', label: 'Deleted notices · 30 days after deletion', table: 'notices', where: `deleted_at is not null and deleted_at < $1::timestamptz - interval '30 days'` },
  { key: 'drafts', label: 'Published / discarded planner drafts · 90 days', table: 'timetable_drafts', where: `status <> 'draft' and updated_at < $1::timestamptz - interval '90 days'` },
];

export const retentionStats = {
  lastRunAt: null as string | null,
  durationMs: 0,
  deleted: {} as Record<string, number>,
  lastError: null as string | null,
};

const BATCH = 5_000;
const MAX_BATCHES_PER_RULE = 40;

/** One rule, in batches of BATCH rows, pausing between them. Returns rows removed. */
async function purge(c: PoolClient, rule: RetentionRule, now: Date): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RULE; i++) {
    const r = await c.query(
      `with doomed as (select ctid from ${rule.table} where ${rule.where} limit ${BATCH})
       delete from ${rule.table} t using doomed where t.ctid = doomed.ctid`,
      [now],
    );
    const n = r.rowCount ?? 0;
    total += n;
    if (n < BATCH) break;
    await new Promise((res) => setTimeout(res, 50)); // let live traffic through
  }
  return total;
}

/**
 * Runs every rule once. Only one server does it at a time (a Postgres advisory lock), so several
 * instances never fight over the same rows. Returns rows removed per rule (null: another server is on it).
 */
export async function runRetention(db: Db, now: Date): Promise<Record<string, number> | null> {
  const c = await db.connect();
  const t0 = Date.now();
  try {
    const { rows } = await c.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext('attendly:retention')) as ok`);
    if (!rows[0]?.ok) return null;
    try {
      const deleted: Record<string, number> = {};
      for (const rule of RETENTION_RULES) deleted[rule.key] = await purge(c, rule, now);
      retentionStats.lastRunAt = new Date().toISOString();
      retentionStats.durationMs = Date.now() - t0;
      retentionStats.deleted = deleted;
      retentionStats.lastError = null;
      return deleted;
    } finally {
      await c.query(`select pg_advisory_unlock(hashtext('attendly:retention'))`).catch(() => undefined);
    }
  } catch (err) {
    retentionStats.lastError = (err as Error).message;
    throw err;
  } finally {
    c.release();
  }
}

/** The biggest tables and the whole database, for the Developer console. */
export async function storageReport(db: Db): Promise<{ dbBytes: number; tables: { name: string; rows: number; bytes: number }[] }> {
  const [size, tables] = await Promise.all([
    db.query<{ bytes: number }>('select pg_database_size(current_database())::bigint as bytes'),
    db.query<{ name: string; rows: number; bytes: number }>(
      `select c.relname as name, greatest(c.reltuples, 0)::bigint as rows, pg_total_relation_size(c.oid)::bigint as bytes
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema() and c.relkind = 'r' and c.relname <> 'schema_migrations'
        order by bytes desc limit 12`,
    ),
  ]);
  return { dbBytes: size.rows[0]?.bytes ?? 0, tables: tables.rows };
}

export const RETENTION_EVERY_MS = 60 * 60_000;
export const _DAY = DAY;
