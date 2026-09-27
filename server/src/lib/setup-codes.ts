/**
 * One-time setup codes: the first sign-in without email. Whoever hands out the code (Attendly's
 * developer for an institution's main admin, an admin for staff and students, the server log for the
 * developer) gives it to the person privately; with it they link Google Authenticator once, and from
 * then on sign in with their ID and the authenticator's 6-digit code.
 *
 * Only a keyed hash is stored. Five wrong guesses burn the code (60 bits: unguessable anyway).
 */
import { timingSafeEqual } from 'node:crypto';
import { SETUP_CODE_ALPHABET, formatSetupCode, randomBytes } from '@attendly/protocol';
import type { Queryable } from '../db';
import type { Hasher } from './secrets';

export const SETUP_CODE_TTL_MS = 7 * 24 * 3_600_000;
export const SETUP_CODE_MAX_ATTEMPTS = 5;

/** 12 characters, uniform over the alphabet (rejection sampling, no modulo bias). */
export function newSetupCode(): string {
  const limit = 256 - (256 % SETUP_CODE_ALPHABET.length);
  let out = '';
  while (out.length < 12) for (const b of randomBytes(16)) if (b < limit && out.length < 12) out += SETUP_CODE_ALPHABET[b % SETUP_CODE_ALPHABET.length];
  return out;
}

export const setupDigest = (hash: Hasher, userId: string, code: string) => hash('setup', `${userId}:${code}`);
const digest = setupDigest;

/** A fresh code for this person (any earlier one stops working). Returns it formatted, once. */
export async function issueSetupCode(db: Queryable, hash: Hasher, userId: string, now: number, ttlMs = SETUP_CODE_TTL_MS): Promise<{ code: string; expiresAt: Date }> {
  const code = newSetupCode();
  const expiresAt = new Date(now + ttlMs);
  await db.query('update users set setup_code_hash = $2, setup_code_expires_at = $3, setup_code_attempts = 0, setup_code_enc = null where id = $1', [userId, digest(hash, userId, code), expiresAt]);
  return { code: formatSetupCode(code), expiresAt };
}

export interface SetupCodeState {
  setup_code_hash: Buffer | null;
  setup_code_expires_at: Date | null;
  setup_code_attempts: number;
}

/** 'ok', or why not ('none' = no usable code: never issued, used, expired or burnt). */
export function checkSetupCode(hash: Hasher, userId: string, s: SetupCodeState, code: string, now: number): 'ok' | 'wrong' | 'none' {
  if (!s.setup_code_hash || !s.setup_code_expires_at || s.setup_code_expires_at.getTime() <= now || s.setup_code_attempts >= SETUP_CODE_MAX_ATTEMPTS) return 'none';
  const d = digest(hash, userId, code);
  return d.length === s.setup_code_hash.length && timingSafeEqual(d, s.setup_code_hash) ? 'ok' : 'wrong';
}
