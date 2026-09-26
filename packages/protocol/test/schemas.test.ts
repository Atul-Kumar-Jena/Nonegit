import { describe, expect, it } from 'vitest';
import { MarkBody, OtpRequestBody, OtpVerifyBody, generateKeyPair, toB64url, randomUUID } from './helpers';

describe('schemas', () => {
  it('normalises email identifiers', () => {
    const r = OtpRequestBody.parse({ channel: 'email', identifier: '  Aarav@IIT.ac.in ' });
    expect(r.identifier).toBe('aarav@iit.ac.in');
  });

  it('rejects bad phones and unknown channels', () => {
    expect(OtpRequestBody.safeParse({ channel: 'phone', identifier: '98765' }).success).toBe(false);
    expect(OtpRequestBody.safeParse({ channel: 'phone', identifier: '+919876543210' }).success).toBe(true);
    expect(OtpRequestBody.safeParse({ channel: 'fax', identifier: 'x' }).success).toBe(false);
  });

  it('validates key and signature sizes', () => {
    const kp = generateKeyPair();
    const base = {
      challengeId: randomUUID(),
      code: '123456',
      device: { publicKey: toB64url(kp.publicKey), platform: 'android', model: 'Pixel 8', osVersion: '15', appVersion: '1.0.0', integrity: { rooted: false, emulator: false } },
      proof: toB64url(new Uint8Array(64)),
    };
    expect(OtpVerifyBody.safeParse(base).success).toBe(true);
    expect(OtpVerifyBody.safeParse({ ...base, proof: toB64url(new Uint8Array(63)) }).success).toBe(false);
    expect(OtpVerifyBody.safeParse({ ...base, code: '12345a' }).success).toBe(false);
    expect(OtpVerifyBody.safeParse({ ...base, device: { ...base.device, publicKey: 'abc' } }).success).toBe(false);
  });

  it('rejects out-of-range locations', () => {
    const loc = { lat: 10, lng: 10, accuracyM: 5, mocked: false, capturedAt: Date.now() };
    expect(MarkBody.safeParse({ qr: 'x', location: loc }).success).toBe(true);
    expect(MarkBody.safeParse({ qr: 'x', location: { ...loc, lat: 100 } }).success).toBe(false);
    expect(MarkBody.safeParse({ qr: 'x', location: { ...loc, lng: NaN } }).success).toBe(false);
    expect(MarkBody.safeParse({ qr: 'x'.repeat(500), location: loc }).success).toBe(false);
  });
});
