import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fromB64url, isB64urlOfLength, toB64url } from '../src';

describe('base64url', () => {
  it('round-trips and matches Node for every length 0..300', () => {
    for (let len = 0; len <= 300; len++) {
      const bytes = new Uint8Array(randomBytes(len));
      const enc = toB64url(bytes);
      expect(enc).toBe(Buffer.from(bytes).toString('base64url'));
      expect(Array.from(fromB64url(enc))).toEqual(Array.from(bytes));
    }
  });

  it('rejects invalid characters, padding and impossible lengths', () => {
    expect(() => fromB64url('ab+c')).toThrow();
    expect(() => fromB64url('ab/c')).toThrow();
    expect(() => fromB64url('abc=')).toThrow();
    expect(() => fromB64url('abcde')).toThrow();
    expect(() => fromB64url('a b')).toThrow();
  });

  it('rejects non-canonical trailing bits', () => {
    // "AA" = 0x00, "AB" has non-zero leftover bits
    expect(Array.from(fromB64url('AA'))).toEqual([0]);
    expect(() => fromB64url('AB')).toThrow();
  });

  it('isB64urlOfLength checks exact decoded length', () => {
    const k = toB64url(new Uint8Array(32));
    expect(isB64urlOfLength(k, 32)).toBe(true);
    expect(isB64urlOfLength(k, 31)).toBe(false);
    expect(isB64urlOfLength(123, 32)).toBe(false);
    expect(isB64urlOfLength('!!', 1)).toBe(false);
  });
});
