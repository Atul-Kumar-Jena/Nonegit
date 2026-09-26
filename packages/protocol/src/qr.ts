/**
 * Rotating session QR tokens.
 *
 * Format: `ATD1.<sessionId:22 b64url>.<seq:decimal>.<mac:22 b64url>`
 *
 *   mac = HMAC-SHA256(sessionSecret, "ATD1|<sessionId>|<seq>")[0..16]
 *   seq = floor((now - startedAt) / rotationSeconds)
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

export function verifyQrMac(secret: Uint8Array, parsed: ParsedQrToken): boolean {
  try {
    return timingSafeEqual(computeQrMac(secret, parsed.sessionId, parsed.seq), parsed.mac);
  } catch {
    return false;
  }
}

/** Current rotation index for a session. */
export function currentQrSeq(startedAtMs: number, nowMs: number, rotationSeconds: number): number {
  if (!(rotationSeconds > 0)) throw new Error('qr: invalid rotation');
  return Math.max(0, Math.floor((nowMs - startedAtMs) / (rotationSeconds * 1000)));
}

/** Milliseconds until the next rotation (for countdown UIs). */
export function msUntilNextRotation(startedAtMs: number, nowMs: number, rotationSeconds: number): number {
  const period = rotationSeconds * 1000;
  const elapsed = Math.max(0, nowMs - startedAtMs);
  return period - (elapsed % period);
}

/**
 * A token is fresh when its seq is the current one, the previous one (scan
 * latency grace) or the next one (faculty-device clock slightly ahead).
 */
export function isQrSeqFresh(seq: number, currentSeq: number): boolean {
  return seq >= currentSeq - 1 && seq <= currentSeq + 1;
}
