/**
 * Layered scans as a hash chain. A student's round k is accepted only on top of rounds 1..k-1 from
 * the same phone, and each link commits to the one before:
 *
 *   link_k = SHA-256( link_{k-1} ‖ "sessionId|userId|k|qrSeq|markedAtMs|deviceFingerprint" ),  link_0 = 32 zero bytes
 *
 * Before the attendance record is written the whole chain is recomputed from the stored rows, so a
 * row edited, inserted or removed behind the server's back breaks it and the student isn't marked.
 */
import { createHash } from 'node:crypto';

export interface RoundLink {
  round: number;
  qr_seq: number | null;
  marked_at: Date;
  device_id: string | null;
  device_fingerprint: string | null;
  chain: Buffer | null;
}

const ZERO = Buffer.alloc(32);

export function linkRound(prev: Buffer | null, sessionId: string, userId: string, round: number, qrSeq: number, markedAt: Date, deviceFingerprint: string): Buffer {
  return createHash('sha256')
    .update(prev ?? ZERO)
    .update(`${sessionId}|${userId}|${round}|${qrSeq}|${markedAt.getTime()}|${deviceFingerprint}`)
    .digest();
}

/** Recomputes the chain; returns its head when rounds 1..n are all there, in order, one phone, untampered. */
export function verifyChain(rows: RoundLink[], sessionId: string, userId: string): Buffer | null {
  const sorted = [...rows].sort((a, b) => a.round - b.round);
  let prev: Buffer | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (r.round !== i + 1 || r.qr_seq === null || !r.device_fingerprint || !r.chain) return null;
    if (i > 0 && (r.device_id !== sorted[0]!.device_id || r.marked_at.getTime() < sorted[i - 1]!.marked_at.getTime())) return null;
    const expect = linkRound(prev, sessionId, userId, r.round, r.qr_seq, r.marked_at, r.device_fingerprint);
    if (!expect.equals(r.chain)) return null;
    prev = expect;
  }
  return prev;
}
