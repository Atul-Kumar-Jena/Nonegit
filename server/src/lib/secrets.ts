import { hmacSha256, randomBytes, randomToken } from '@attendly/protocol';

/**
 * Keyed hashing of every secret we persist (OTP codes, bearer tokens, tickets).
 * A database dump alone is useless to an attacker without the pepper.
 */
export function makeHasher(pepper: Uint8Array) {
  return (purpose: string, value: string): Buffer => Buffer.from(hmacSha256(pepper, `${purpose}\u0000${value}`));
}
export type Hasher = ReturnType<typeof makeHasher>;

export { randomToken };

/** Uniform 6-digit code via rejection sampling (no modulo bias). */
export function generateOtpCode(): string {
  const limit = 4_294_000_000; // largest multiple of 10^6 below 2^32
  for (;;) {
    const b = randomBytes(4);
    const n = ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!;
    if (n < limit) return String(n % 1_000_000).padStart(6, '0');
  }
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${head}•••@${domain}`;
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}•••••${phone.slice(-4)}`;
}
