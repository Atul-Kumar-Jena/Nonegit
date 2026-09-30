import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  bytesToUuid,
  currentQrSeq,
  encodeQrToken,
  isQrSeqFresh,
  msUntilNextRotation,
  parseQrToken,
  randomBytes,
  uuidToBytes,
  verifyQrMac,
  qrRoundOf,
  qrRoundSecret,
  QR_MAX_LENGTH,
  seqLabel,
} from '../src';

describe('rotating QR tokens', () => {
  const secret = randomBytes(32);
  const sid = randomUUID();

  it('uuid <-> bytes round-trips', () => {
    expect(bytesToUuid(uuidToBytes(sid))).toBe(sid);
    expect(() => uuidToBytes('nope')).toThrow();
  });

  it('encodes, parses and verifies', () => {
    const tok = encodeQrToken(secret, sid, 42);
    expect(tok.length).toBeLessThanOrEqual(QR_MAX_LENGTH);
    const p = parseQrToken(tok)!;
    expect(p.sessionId).toBe(sid);
    expect(p.seq).toBe(42);
    expect(verifyQrMac(secret, p)).toBe(true);
  });

  it('fails verification with the wrong secret, seq or session', () => {
    const p = parseQrToken(encodeQrToken(secret, sid, 5))!;
    expect(verifyQrMac(randomBytes(32), p)).toBe(false);
    expect(verifyQrMac(secret, { ...p, seq: 6 })).toBe(false);
    expect(verifyQrMac(secret, { ...p, sessionId: randomUUID() })).toBe(false);
  });

  it('rejects malformed tokens', () => {
    for (const bad of [
      '',
      'ATD1',
      'ATD2.a.1.b',
      'ATD1.x.1.y',
      `ATD1.${'A'.repeat(22)}.01.${'A'.repeat(22)}`, // leading zero seq
      `ATD1.${'A'.repeat(22)}.-1.${'A'.repeat(22)}`,
      `ATD1.${'A'.repeat(22)}.1.${'A'.repeat(21)}`,
      'x'.repeat(200),
      null,
      42,
    ]) {
      expect(parseQrToken(bad)).toBeNull();
    }
  });

  it('computes epoch-based seq and freshness window', () => {
    expect(currentQrSeq(0, 7)).toBe(0);
    expect(currentQrSeq(6_999, 7)).toBe(0);
    expect(currentQrSeq(7_000, 7)).toBe(1);
    expect(currentQrSeq(1_790_000_000_000, 7)).toBe(Math.floor(1_790_000_000_000 / 7000));
    expect(currentQrSeq(-5, 7)).toBe(0);
    expect(msUntilNextRotation(1_000, 7)).toBe(6_000);
    expect(seqLabel(255_714_285)).toBe('#4285');
    // Fits the token grammar (≤ 10 digits) even at the fastest rotation for centuries.
    expect(String(currentQrSeq(Date.UTC(2200, 0, 1), 3)).length).toBeLessThanOrEqual(10);
    expect(isQrSeqFresh(10, 10)).toBe(true);
    expect(isQrSeqFresh(9, 10)).toBe(true);
    expect(isQrSeqFresh(11, 10)).toBe(true);
    expect(isQrSeqFresh(8, 10)).toBe(false);
    expect(isQrSeqFresh(12, 10)).toBe(false);
  });
});

describe('isQrFreshAt — a code dies when it changes', async () => {
  const { isQrFreshAt } = await import('../src/qr');
  it('the current code is fine; the previous only within 2.5 s of the switch; the next only 2.5 s early', () => {
    const P = 5000;
    const base = 1000 * P; // start of window 1000
    expect(isQrFreshAt(1000, base + 2500, 5)).toBe(true);
    expect(isQrFreshAt(999, base + 1000, 5)).toBe(true);
    expect(isQrFreshAt(999, base + 2000, 5)).toBe(true);
    expect(isQrFreshAt(999, base + 3000, 5)).toBe(false);
    expect(isQrFreshAt(1001, base + P - 1000, 5)).toBe(true);
    expect(isQrFreshAt(1001, base + 2000, 5)).toBe(false);
    expect(isQrFreshAt(1001, base + P - 2000, 5)).toBe(true);
    expect(isQrFreshAt(998, base + 100, 5)).toBe(false);
  });
});

describe('layered scans: one key per round', () => {
  it('round 1 is the class key; later rounds get their own; a code says which round it is', () => {
    const secret = randomBytes(32);
    const sid = randomUUID();
    expect(qrRoundSecret(secret, 1)).toBe(secret);
    const k2 = qrRoundSecret(secret, 2);
    expect(k2.length).toBe(32);
    expect(Buffer.from(k2).equals(Buffer.from(secret))).toBe(false);
    expect(Buffer.from(qrRoundSecret(secret, 3)).equals(Buffer.from(k2))).toBe(false);
    const r2 = parseQrToken(encodeQrToken(k2, sid, 9))!;
    expect(qrRoundOf(secret, r2, 3)).toBe(2);
    // Round 2 not open yet (only round 1 is): its code matches nothing.
    expect(qrRoundOf(secret, r2, 1)).toBeNull();
    expect(qrRoundOf(randomBytes(32), r2, 3)).toBeNull();
  });
});

