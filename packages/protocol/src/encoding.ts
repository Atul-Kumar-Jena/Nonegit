/**
 * Byte/string encodings that behave identically in Node, Hermes (React Native)
 * and browsers. Deliberately avoids `Buffer`, `atob` and `btoa`.
 */
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes, utf8ToBytes };

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i++) B64URL_LOOKUP[B64URL[i] as string] = i;

/** Unpadded base64url (RFC 4648 §5). */
export function toB64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Strict unpadded base64url decoder. Throws on any invalid character,
 * impossible length, or non-canonical trailing bits (so every byte string
 * has exactly one accepted encoding).
 */
export function fromB64url(str: string): Uint8Array {
  if (typeof str !== 'string') throw new TypeError('base64url: expected string');
  if (str.length % 4 === 1) throw new Error('base64url: invalid length');
  const out = new Uint8Array(Math.floor((str.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < str.length; i++) {
    const v = B64URL_LOOKUP[str[i] as string];
    if (v === undefined) throw new Error('base64url: invalid character');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new Error('base64url: non-canonical encoding');
  return out;
}

/** Returns true when `str` is canonical base64url that decodes to exactly `len` bytes. */
export function isB64urlOfLength(str: unknown, len: number): str is string {
  if (typeof str !== 'string') return false;
  try {
    return fromB64url(str).length === len;
  } catch {
    return false;
  }
}

/**
 * Strict UTF-8 decoder that doesn't rely on TextDecoder (absent on some
 * JavaScript engines). Throws on malformed input.
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i]!;
    let cp: number;
    let need: number;
    if (b0 < 0x80) {
      cp = b0;
      need = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f;
      need = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f;
      need = 2;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07;
      need = 3;
    } else throw new Error('utf8: invalid lead byte');
    if (i + need >= bytes.length && need > 0) throw new Error('utf8: truncated');
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) throw new Error('utf8: invalid continuation');
      cp = (cp << 6) | (b & 0x3f);
    }
    if ((need === 2 && cp < 0x800) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('utf8: invalid code point');
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}
