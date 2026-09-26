/**
 * Cryptographic primitives shared by the server and every Attendly client.
 *
 *  - Ed25519 (RFC 8032, strict verification — non-canonical encodings and
 *    ZIP-215 edge cases are rejected) for device and server signatures.
 *  - SHA-256 / HMAC-SHA-256 for digests, token hashing and rotating QR MACs.
 *
 * All implementations come from the audited, dependency-free @noble libraries
 * so that the exact same code runs on the server and on phones.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';
import { bytesToHex, fromB64url, toB64url, utf8ToBytes } from './encoding';

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SECRET_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Cryptographically secure random bytes (throws if no CSPRNG is available). */
export function randomBytes(len: number): Uint8Array {
  return nobleRandomBytes(len);
}

/** Random unpadded base64url token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return toB64url(randomBytes(bytes));
}

export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

export function publicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== ED25519_SECRET_KEY_BYTES) throw new Error('ed25519: invalid secret key length');
  return ed25519.getPublicKey(secretKey);
}

export function sign(message: Uint8Array | string, secretKey: Uint8Array): Uint8Array {
  const msg = typeof message === 'string' ? utf8ToBytes(message) : message;
  return ed25519.sign(msg, secretKey);
}

/** Strict RFC 8032 verification. Never throws — malformed input simply fails. */
export function verify(signature: Uint8Array, message: Uint8Array | string, publicKey: Uint8Array): boolean {
  try {
    if (signature.length !== ED25519_SIGNATURE_BYTES || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false;
    const msg = typeof message === 'string' ? utf8ToBytes(message) : message;
    return ed25519.verify(signature, msg, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** Validates that `bytes` is a canonical, non-small-order Ed25519 public key. */
export function isValidPublicKey(bytes: Uint8Array): boolean {
  try {
    if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) return false;
    if (!ed25519.utils.isValidPublicKey(bytes, false)) return false;
    const point = ed25519.Point.fromBytes(bytes, false);
    return !point.isSmallOrder();
  } catch {
    return false;
  }
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === 'string' ? utf8ToBytes(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256Bytes(data));
}

export function hmacSha256(key: Uint8Array, data: Uint8Array | string): Uint8Array {
  return hmac(sha256, key, typeof data === 'string' ? utf8ToBytes(data) : data);
}

/** Constant-time byte comparison (length leak only). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/**
 * Human-friendly key fingerprint, e.g. "a4f3-bb19-8c2d". This is what the UI
 * calls the device "HWID". It is derived from the public key, so it can be
 * shown anywhere without revealing anything secret.
 */
export function keyFingerprint(publicKey: Uint8Array): string {
  const hex = sha256Hex(publicKey).slice(0, 12);
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

export function signB64(message: string, secretKey: Uint8Array): string {
  return toB64url(sign(message, secretKey));
}

export function verifyB64(signatureB64: string, message: string, publicKey: Uint8Array): boolean {
  try {
    return verify(fromB64url(signatureB64), message, publicKey);
  } catch {
    return false;
  }
}
