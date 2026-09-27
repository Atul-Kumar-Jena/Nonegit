import { X509Certificate } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AttestationError, bindChallenge, serialKey, verifyAndroidAttestation, verifyHardwareSignature, type AttestationPolicy } from '../src/lib/attestation';
import { GOOGLE_ATTESTATION_ROOTS } from '../src/lib/attestation-roots';
import { createAttestCA, type LeafOptions } from './attest-helper';

const ca = createAttestCA();
const evil = createAttestCA();
afterAll(() => {
  ca.cleanup();
  evil.cleanup();
});
const challenge = bindChallenge('ticket-1');
const policy: AttestationPolicy = { challenge, packages: ['app.attendly.student', 'app.attendly.institute'], roots: [ca.rootPem] };
const chainFor = (o: LeafOptions = {}) => ca.issue(challenge, o).chain;
const fails = (chain: string[], p: Partial<AttestationPolicy> = {}) => {
  try {
    verifyAndroidAttestation(chain, { ...policy, ...p });
  } catch (e) {
    if (e instanceof AttestationError) return e.code;
    throw e;
  }
  return 'passed';
};
const good = ca.issue(challenge);

describe('Android key attestation', () => {
  it('accepts a TEE key on a locked, verified phone made by our app', () => {
    const r = verifyAndroidAttestation(good.chain, policy);
    expect(r).toMatchObject({ securityLevel: 'tee', deviceLocked: true, verifiedBootState: 'verified', packageName: 'app.attendly.student', osPatchLevel: 202608 });
  });

  it('recognises StrongBox', () => {
    expect(verifyAndroidAttestation(chainFor({ level: 2 }), policy).securityLevel).toBe('strongbox');
  });

  it('the challenge ties the attestation to this one sign-in', () => {
    expect(fails(good.chain, { challenge: bindChallenge('ticket-2') })).toBe('challenge');
  });

  it('refuses software keys (emulators, phones without secure hardware)', () => {
    expect(fails(chainFor({ level: 0 }))).toBe('software');
  });

  it('refuses unlocked bootloaders, custom ROMs and a missing root of trust', () => {
    expect(fails(chainFor({ locked: false, boot: 2 }))).toBe('boot');
    expect(fails(chainFor({ boot: 1 }))).toBe('boot');
    expect(fails(chainFor({ locked: false }))).toBe('boot');
    expect(fails(chainFor({ rootOfTrust: false }))).toBe('boot');
  });

  it('refuses keys made by another app (a clone of Attendly); a missing app ID is merely unverifiable', () => {
    expect(fails(chainFor({ pkg: 'com.evil.clone' }))).toBe('package');
    expect(fails(good.chain, { packages: ['app.attendly.institute'] })).toBe('package');
    expect(fails(chainFor({ appId: false }))).toBe('malformed');
  });

  it('checks the app signing certificate when configured', () => {
    expect(fails(good.chain, { signingCertDigests: ['AB:'.repeat(32).slice(0, -1)] })).toBe('passed');
    expect(fails(good.chain, { signingCertDigests: ['cd'.repeat(32)] })).toBe('signing_cert');
  });

  it('refuses chains that don’t end at a trusted root, or are stitched together', () => {
    const forged = evil.issue(challenge).chain;
    expect(fails(forged)).toBe('root');
    const [leaf, inter, root] = good.chain;
    expect(fails([leaf!, forged[1]!, forged[2]!], { roots: [ca.rootPem, evil.rootPem] })).toBe('chain');
    expect(fails([leaf!, root!])).toBe('chain');
    expect(fails([leaf!])).toBe('chain');
    expect(fails([leaf!, inter!, root!, 'bm90IGEgY2VydA=='])).toBe('malformed');
    // Production trusts only Google's roots.
    expect(fails(good.chain, { roots: undefined })).toBe('root');
  });

  it('refuses a chain containing a certificate Google revoked', () => {
    expect(fails(good.chain, { revoked: new Set([serialKey(ca.interSerial)]) })).toBe('revoked');
    expect(fails(good.chain, { revoked: new Set(['deadbeef']) })).toBe('passed');
  });

  it('refuses tampered certificates', () => {
    const leaf = Buffer.from(good.chain[0]!, 'base64');
    const i = leaf.indexOf(Buffer.from('app.attendly.student'));
    leaf.write('app.attendly.studenX', i);
    expect(fails([leaf.toString('base64'), ...good.chain.slice(1)])).toBe('chain');
  });

  it('verifies signatures made by the hardware key', () => {
    const { keySpki } = verifyAndroidAttestation(good.chain, policy);
    const sig = good.sign('POST\n/v1/attendance/mark');
    expect(verifyHardwareSignature(keySpki, 'POST\n/v1/attendance/mark', sig)).toBe(true);
    expect(verifyHardwareSignature(keySpki, 'POST\n/v1/attendance/markX', sig)).toBe(false);
    expect(verifyHardwareSignature(keySpki, 'x', 'garbage')).toBe(false);
  });

  it('ships Google’s attestation roots', () => {
    expect(GOOGLE_ATTESTATION_ROOTS).toHaveLength(2);
    for (const pem of GOOGLE_ATTESTATION_ROOTS) {
      const c = new X509Certificate(pem);
      expect(c.verify(c.publicKey)).toBe(true);
    }
    expect(serialKey('00F92009E853B6B045')).toBe('f92009e853b6b045');
  });
});

describe('Google’s revocation list', () => {
  it('is loaded from Google’s status feed and applied to every chain', async () => {
    const { refreshRevocations, checkAttestation, setRevokedSerials } = await import('../src/lib/device-trust');
    const feed = { entries: { [ca.interSerial.toUpperCase()]: { status: 'REVOKED', reason: 'KEY_COMPROMISE' }, '2c8cdddfd5e03bfc': { status: 'SUSPENDED' } } };
    const n = await refreshRevocations((async () => new Response(JSON.stringify(feed))) as unknown as typeof fetch);
    expect(n).toBe(2);
    const deps = { config: { attestation: { requireHardware: false, appCertDigests: [], testRoots: [ca.rootPem] } } } as never;
    const codes: string[] = [];
    expect(() => checkAttestation(deps, good.chain, challenge, false, false, (c) => codes.push(c))).toThrow(/revoked/);
    expect(codes).toEqual(['revoked']);
    await expect(refreshRevocations((async () => new Response('nope', { status: 503 })) as unknown as typeof fetch)).rejects.toThrow(/503/);
    // Older entries are decimal.
    setRevokedSerials([BigInt(`0x${ca.interSerial}`).toString(10)]);
    expect(() => checkAttestation(deps, good.chain, challenge, false, false, () => {})).toThrow(/revoked/);
    setRevokedSerials([]);
    expect(checkAttestation(deps, good.chain, challenge, false, false, () => {})?.level).toBe('tee');
  });
});
