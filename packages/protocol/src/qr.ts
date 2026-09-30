/**
 * Rotating session QR tokens.
 *
 * Format: `ATD1.<sessionId:22 b64url>.<seq:decimal>.<mac:22 b64url>`
 *
 *   mac = HMAC-SHA256(sessionSecret, "ATD1|<sessionId>|<seq>")[0..16]
 *   seq = floor(unixTimeMs / (rotationSeconds · 1000))
 *
 * This is a TOTP-style construction (RFC 6238 idea, 128-bit truncated MAC).
 * Only the server and the faculty device that runs the session know the
 * 32-byte secret, so tokens cannot be forged; they expire after one rotation
 * window (plus one window of grace for scan latency), so screenshots go stale.
 */
import { fromB64url, toB64url } from './encoding';
import { hmacSha256, timingSafeEqual } from './crypto';

export const QR_PREFIX = 'ATD1';
export const QR_MAC_BYTES = 16;
export const QR_SECRET_BYTES = 32;
/** Maximum accepted token length — anything longer is rejected before parsing. */
export const QR_MAX_LENGTH = 96;

export interface ParsedQrToken {
  sessionId: string; // UUID
  seq: number;
  mac: Uint8Array;
}

const HEX = '0123456789abcdef';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function uuidToBytes(uuid: string): Uint8Array {
  const u = uuid.toLowerCase();
  if (!UUID_RE.test(u)) throw new Error('invalid uuid');
  const hex = u.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToUuid(b: Uint8Array): string {
  if (b.length !== 16) throw new Error('invalid uuid bytes');
  let h = '';
  for (let i = 0; i < 16; i++) h += HEX[(b[i] as number) >> 4]! + HEX[(b[i] as number) & 15]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function macInput(sessionId: string, seq: number): string {
  return `${QR_PREFIX}|${sessionId.toLowerCase()}|${seq}`;
}

export function computeQrMac(secret: Uint8Array, sessionId: string, seq: number): Uint8Array {
  if (secret.length !== QR_SECRET_BYTES) throw new Error('qr: invalid secret length');
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('qr: invalid seq');
  return hmacSha256(secret, macInput(sessionId, seq)).slice(0, QR_MAC_BYTES);
}

export function encodeQrToken(secret: Uint8Array, sessionId: string, seq: number): string {
  const mac = computeQrMac(secret, sessionId, seq);
  return `${QR_PREFIX}.${toB64url(uuidToBytes(sessionId))}.${seq}.${toB64url(mac)}`;
}

/** Parses a token without verifying it. Returns null for anything malformed. */
export function parseQrToken(token: unknown): ParsedQrToken | null {
  if (typeof token !== 'string' || token.length > QR_MAX_LENGTH) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 4 || parts[0] !== QR_PREFIX) return null;
  const [, sidB64, seqStr, macB64] = parts as [string, string, string, string];
  if (!/^(0|[1-9][0-9]{0,9})$/.test(seqStr)) return null;
  try {
    const sidBytes = fromB64url(sidB64);
    const mac = fromB64url(macB64);
    if (sidBytes.length !== 16 || mac.length !== QR_MAC_BYTES) return null;
    return { sessionId: bytesToUuid(sidBytes), seq: Number(seqStr), mac };
  } catch {
    return null;
  }
}

/**
 * Layered scans: every round has its own key, derived from the class secret, so a code from round 1
 * can never count for round 2 (and a round's codes exist only once the professor opens it).
 * Round 1 uses the class secret itself.
 */
export function qrRoundSecret(secret: Uint8Array, round: number): Uint8Array {
  if (!Number.isInteger(round) || round < 1 || round > 9) throw new Error('qr: invalid round');
  return round === 1 ? secret : hmacSha256(secret, `${QR_PREFIX}-ROUND|${round}`).slice(0, QR_SECRET_BYTES);
}

/** Which round (1..maxRound) a verified token belongs to, or null when it matches none. */
export function qrRoundOf(secret: Uint8Array, parsed: ParsedQrToken, maxRound: number): number | null {
  for (let r = Math.max(1, Math.min(9, maxRound)); r >= 1; r--) if (verifyQrMac(qrRoundSecret(secret, r), parsed)) return r;
  return null;
}

export function verifyQrMac(secret: Uint8Array, parsed: ParsedQrToken): boolean {
  try {
    return timingSafeEqual(computeQrMac(secret, parsed.sessionId, parsed.seq), parsed.mac);
  } catch {
    return false;
  }
}

/**
 * Rotation index at `nowMs`. Epoch-based (not relative to when the session
 * started), so a teacher's phone can display valid codes with no internet:
 * it only needs the session secret and a synced clock.
 */
export function currentQrSeq(nowMs: number, rotationSeconds: number): number {
  if (!(rotationSeconds > 0)) throw new Error('qr: invalid rotation');
  return Math.max(0, Math.floor(nowMs / (rotationSeconds * 1000)));
}

/** Milliseconds until the next rotation (for countdown UIs). */
export function msUntilNextRotation(nowMs: number, rotationSeconds: number): number {
  const period = rotationSeconds * 1000;
  return period - (Math.max(0, nowMs) % period);
}

/** Short display label for a sequence number, e.g. "#0024". */
export function seqLabel(seq: number): string {
  return `#${String(seq % 10_000).padStart(4, '0')}`;
}

/**
 * A token is fresh when its seq is the current one, the previous one (scan
 * latency grace) or the next one (faculty-device clock slightly ahead).
 */
export function isQrSeqFresh(seq: number, currentSeq: number): boolean {
  return seq >= currentSeq - 1 && seq <= currentSeq + 1;
}

/** How long a code outlives its window (and may appear early): only clock differences, never more. */
export const QR_EDGE_GRACE_MS = 2500;

/**
 * Strict freshness at the moment of scanning: the code on screen then, or its neighbour only within
 * 2.5 s of the switch (the professor's phone clock a moment off). A screenshot is useless seconds
 * after the code changes — there is no "countdown" during which an old code still works.
 */
export function isQrFreshAt(seq: number, scanMs: number, rotationSeconds: number, graceMs = QR_EDGE_GRACE_MS): boolean {
  const period = rotationSeconds * 1000;
  const cur = currentQrSeq(scanMs, rotationSeconds);
  if (seq === cur) return true;
  const into = scanMs - cur * period;
  if (seq === cur - 1) return into <= graceMs;
  if (seq === cur + 1) return period - into <= graceMs;
  return false;
}
