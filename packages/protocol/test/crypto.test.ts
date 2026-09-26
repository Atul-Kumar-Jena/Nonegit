import { describe, expect, it } from 'vitest';
import { createHmac, createPublicKey, verify as nodeVerify, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  generateKeyPair,
  hexToBytes,
  bytesToHex,
  hmacSha256,
  isValidPublicKey,
  keyFingerprint,
  publicKeyFromSecret,
  sha256Hex,
  sign,
  timingSafeEqual,
  toB64url,
  verify,
  verifyB64,
  signB64,
} from '../src';

describe('ed25519', () => {
  it('matches the RFC 8032 test vector 1', () => {
    const sk = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    const pk = publicKeyFromSecret(sk);
    expect(bytesToHex(pk)).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const sig = sign(new Uint8Array(0), sk);
    expect(bytesToHex(sig)).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    expect(verify(sig, new Uint8Array(0), pk)).toBe(true);
  });

  it('interoperates with Node/OpenSSL Ed25519 in both directions', () => {
    const kp = generateKeyPair();
    const msg = 'interop ✓';
    const nodePub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: toB64url(kp.publicKey) }, format: 'jwk' });
    expect(nodeVerify(null, Buffer.from(msg), nodePub, Buffer.from(sign(msg, kp.secretKey)))).toBe(true);

    const nk = generateKeyPairSync('ed25519');
    const x = nk.publicKey.export({ format: 'jwk' }).x as string;
    const pub = new Uint8Array(Buffer.from(x, 'base64url'));
    const sig = new Uint8Array(nodeSign(null, Buffer.from(msg), nk.privateKey));
    expect(verify(sig, msg, pub)).toBe(true);
  });

  it('rejects tampered messages, signatures and wrong keys without throwing', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sig = sign('hello', a.secretKey);
    expect(verify(sig, 'hello', a.publicKey)).toBe(true);
    expect(verify(sig, 'hellp', a.publicKey)).toBe(false);
    expect(verify(sig, 'hello', b.publicKey)).toBe(false);
    const bad = sig.slice();
    bad[10]! ^= 1;
    expect(verify(bad, 'hello', a.publicKey)).toBe(false);
    expect(verify(sig.slice(0, 63), 'hello', a.publicKey)).toBe(false);
    expect(verify(sig, 'hello', new Uint8Array(32))).toBe(false);
    expect(verifyB64('%%%', 'hello', a.publicKey)).toBe(false);
    expect(verifyB64(signB64('hello', a.secretKey), 'hello', a.publicKey)).toBe(true);
  });

  it('rejects signatures with a non-canonical S (malleability)', () => {
    const a = generateKeyPair();
    const sig = sign('m', a.secretKey);
    // S' = S + L  (group order) produces a malleable signature that strict verification must refuse.
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
    let s2 = s + L;
    const mal = sig.slice();
    for (let i = 32; i < 64; i++) {
      mal[i] = Number(s2 & 0xffn);
      s2 >>= 8n;
    }
    expect(verify(mal, 'm', a.publicKey)).toBe(false);
  });

  it('validates public keys (length, canonical, not small-order)', () => {
    expect(isValidPublicKey(generateKeyPair().publicKey)).toBe(true);
    expect(isValidPublicKey(new Uint8Array(31))).toBe(false);
    // identity point (small order)
    const identity = new Uint8Array(32);
    identity[0] = 1;
    expect(isValidPublicKey(identity)).toBe(false);
  });
});

describe('hashing', () => {
  it('sha256 and hmac match Node', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const key = new Uint8Array(32).fill(7);
    expect(bytesToHex(hmacSha256(key, 'data'))).toBe(createHmac('sha256', Buffer.from(key)).update('data').digest('hex'));
  });

  it('timingSafeEqual', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('fingerprint format', () => {
    expect(keyFingerprint(generateKeyPair().publicKey)).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });
});
