import { sha256Bytes } from '@attendly/protocol';
import type { Queryable } from '../db';
import { canonicalJson } from './canonical';

const AUDIT_LOCK = 7_413_002;
const GENESIS = Buffer.alloc(32);

export interface AuditEntry {
  tenantId?: string | null;
  actorType: 'user' | 'system';
  actorId?: string | null;
  action: string;
  subject?: string | null;
  data?: Record<string, unknown>;
}

function entryBytes(at: string, e: Required<Omit<AuditEntry, 'data'>> & { data: Record<string, unknown> }): string {
  return canonicalJson({
    at,
    tenantId: e.tenantId,
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    subject: e.subject,
    data: e.data,
  });
}

function chain(prev: Uint8Array, body: string): Buffer {
  const b = new TextEncoder().encode(body);
  const buf = new Uint8Array(prev.length + b.length);
  buf.set(prev, 0);
  buf.set(b, prev.length);
  return Buffer.from(sha256Bytes(buf));
}

/**
 * Appends to the hash-chained audit log. Must be called inside a transaction:
 * the advisory lock serialises writers so the chain never forks.
 */
export async function appendAudit(tx: Queryable, entry: AuditEntry): Promise<void> {
  await tx.query('select pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
  const prev = await tx.query<{ hash: Buffer }>('select hash from audit_log order by id desc limit 1');
  const prevHash = prev.rows[0]?.hash ?? GENESIS;
  // Millisecond precision so the value survives the timestamptz round-trip exactly.
  const at = new Date().toISOString();
  const e = {
    tenantId: entry.tenantId ?? null,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    subject: entry.subject ?? null,
    data: entry.data ?? {},
  };
  const hash = chain(prevHash, entryBytes(at, e));
  await tx.query(
    `insert into audit_log(at, tenant_id, actor_type, actor_id, action, subject, data, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [at, e.tenantId, e.actorType, e.actorId, e.action, e.subject, JSON.stringify(e.data), prevHash, hash],
  );
}

export interface AuditVerification {
  ok: boolean;
  checked: number;
  brokenAtId?: number;
  headHash?: string;
}

/** Recomputes the whole chain; any edit, deletion or reordering is detected. */
export async function verifyAuditChain(db: Queryable, batch = 5000): Promise<AuditVerification> {
  let prevHash: Buffer = GENESIS;
  let lastId = 0;
  let checked = 0;
  for (;;) {
    const { rows } = await db.query<{
      id: number;
      at: Date;
      tenant_id: string | null;
      actor_type: 'user' | 'system';
      actor_id: string | null;
      action: string;
      subject: string | null;
      data: Record<string, unknown>;
      prev_hash: Buffer;
      hash: Buffer;
    }>('select * from audit_log where id > $1 order by id limit $2', [lastId, batch]);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (!r.prev_hash.equals(prevHash)) return { ok: false, checked, brokenAtId: r.id };
      const expected = chain(
        prevHash,
        entryBytes(r.at.toISOString(), {
          tenantId: r.tenant_id,
          actorType: r.actor_type,
          actorId: r.actor_id,
          action: r.action,
          subject: r.subject,
          data: r.data,
        }),
      );
      if (!expected.equals(r.hash)) return { ok: false, checked, brokenAtId: r.id };
      prevHash = r.hash;
      lastId = r.id;
      checked++;
    }
  }
  return { ok: true, checked, headHash: prevHash.toString('hex') };
}
