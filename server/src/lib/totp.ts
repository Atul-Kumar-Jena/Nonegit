/**
 * RFC 6238 time-based one-time codes (what Google Authenticator shows): HMAC-SHA1,
 * 30-second steps, 6 digits. Secrets are encrypted at rest with AES-256-GCM.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_S = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function totpAt(secret: Uint8Array, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const n = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const stepOf = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP_S);

/**
 * Checks a code against the current step ±1 (phone clocks drift). Returns the matching step,
 * or null. Steps at or before `lastStep` are refused, so a code works only once.
 */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepOf(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secret: Uint8Array, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_S}`;
}

/** AES-256-GCM with a key derived from the server pepper; output = iv(12) ‖ tag(16) ‖ ciphertext. */
export function makeSecretBox(pepper: Uint8Array) {
  const key = Buffer.from(hkdfSync('sha256', pepper, Buffer.alloc(0), 'attendly totp secret v1', 32));
  return {
    seal(plain: Uint8Array): Buffer {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    open(sealed: Buffer): Buffer {
      const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      d.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
    },
  };
}
