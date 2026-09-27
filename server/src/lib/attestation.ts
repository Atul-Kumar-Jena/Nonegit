/**
 * Android key attestation — proof that a phone's signing key lives in secure hardware.
 *
 * The phone creates a P-256 key inside its TEE / StrongBox with our one-time challenge; Android
 * returns a certificate chain ending at a Google attestation root. We check, in order:
 *   1. every certificate is signed by the next, and the last is one of Google's roots (pinned by key);
 *   2. no certificate in the chain was revoked by Google (leaked batch keys);
 *   3. the leaf's Android attestation record (OID 1.3.6.1.4.1.11129.2.1.17):
 *        • the challenge is exactly ours (fresh, single-use, bound to this sign-in),
 *        • the key is in the TEE or StrongBox (not "software": emulators, no secure hardware),
 *        • hardware says the bootloader is locked and the OS verified (not rooted / custom ROM),
 *        • the key was made by our app (package name, and optionally our signing certificate).
 * Parsing is strict DER; anything malformed is refused.
 */
import { X509Certificate, createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { attestBindChallengeString } from '@attendly/protocol';
import { GOOGLE_ATTESTATION_ROOTS } from './attestation-roots';

export type AttestationFailure = 'malformed' | 'chain' | 'root' | 'revoked' | 'challenge' | 'software' | 'boot' | 'package' | 'signing_cert' | 'key';

export class AttestationError extends Error {
  constructor(
    readonly code: AttestationFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface AttestationResult {
  securityLevel: 'tee' | 'strongbox';
  deviceLocked: boolean;
  verifiedBootState: 'verified' | 'self_signed' | 'unverified' | 'failed';
  packageName: string;
  signatureDigests: string[];
  /** The hardware key (SubjectPublicKeyInfo, DER) — used to verify its signatures later. */
  keySpki: Buffer;
  osPatchLevel: number | null;
  attestationVersion: number;
}

// ───────────────────────────── strict DER ─────────────────────────────

interface Der {
  cls: number; // 0 universal, 1 application, 2 context, 3 private
  constructed: boolean;
  tag: number;
  content: Buffer;
}

function readDer(buf: Buffer, offset: number): { node: Der; next: number } {
  let i = offset;
  if (i >= buf.length) throw new AttestationError('malformed', 'Truncated attestation data.');
  const first = buf[i++]!;
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    // High tag number form (Android uses tags like [704]).
    tag = 0;
    let b: number;
    let n = 0;
    do {
      if (i >= buf.length || ++n > 4) throw new AttestationError('malformed', 'Bad tag in attestation data.');
      b = buf[i++]!;
      tag = (tag << 7) | (b & 0x7f);
    } while (b & 0x80);
  }
  if (i >= buf.length) throw new AttestationError('malformed', 'Truncated attestation data.');
  let len = buf[i++]!;
  if (len === 0x80) throw new AttestationError('malformed', 'Indefinite length is not DER.');
  if (len > 0x80) {
    const n = len & 0x7f;
    if (n > 4 || i + n > buf.length) throw new AttestationError('malformed', 'Bad length in attestation data.');
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i++]!;
  }
  if (i + len > buf.length) throw new AttestationError('malformed', 'Attestation data runs past its end.');
  return { node: { cls, constructed, tag, content: buf.subarray(i, i + len) }, next: i + len };
}

function parseOne(buf: Buffer): Der {
  const { node, next } = readDer(buf, 0);
  if (next !== buf.length) throw new AttestationError('malformed', 'Trailing bytes in attestation data.');
  return node;
}

function children(n: Der): Der[] {
  if (!n.constructed) throw new AttestationError('malformed', 'Expected a structure in attestation data.');
  const out: Der[] = [];
  let off = 0;
  while (off < n.content.length) {
    const r = readDer(n.content, off);
    out.push(r.node);
    off = r.next;
  }
  return out;
}

const UNIVERSAL = { BOOLEAN: 1, INTEGER: 2, OCTET_STRING: 4, OID: 6, ENUMERATED: 10, SEQUENCE: 16, SET: 17 } as const;

function expect(n: Der | undefined, tag: number, what: string): Der {
  if (!n || n.cls !== 0 || n.tag !== tag) throw new AttestationError('malformed', `Attestation record: bad ${what}.`);
  return n;
}

function int(n: Der | undefined, what: string, tag: number = UNIVERSAL.INTEGER): number {
  const c = expect(n, tag, what).content;
  if (c.length === 0 || c.length > 6) throw new AttestationError('malformed', `Attestation record: bad ${what}.`);
  let v = 0;
  for (const b of c) v = v * 256 + b;
  if (c[0]! & 0x80) v -= 2 ** (8 * c.length);
  return v;
}

function oid(n: Der): string {
  const c = expect(n, UNIVERSAL.OID, 'OID').content;
  const parts: number[] = [];
  let v = 0;
  for (let i = 0; i < c.length; i++) {
    v = v * 128 + (c[i]! & 0x7f);
    if (!(c[i]! & 0x80)) {
      if (!parts.length) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
      else parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

const KEY_DESCRIPTION_OID = '1.3.6.1.4.1.11129.2.1.17';

/** The certificate's extensions, from its raw DER. */
function extensionValue(certDer: Buffer, wanted: string): Buffer | null {
  const cert = children(expect(parseOne(certDer), UNIVERSAL.SEQUENCE, 'certificate'));
  const tbs = children(expect(cert[0], UNIVERSAL.SEQUENCE, 'certificate body'));
  const exts = tbs.find((x) => x.cls === 2 && x.tag === 3);
  if (!exts) return null;
  for (const ext of children(expect(children(exts)[0], UNIVERSAL.SEQUENCE, 'extensions'))) {
    const parts = children(expect(ext, UNIVERSAL.SEQUENCE, 'extension'));
    if (oid(parts[0]!) === wanted) return expect(parts[parts.length - 1], UNIVERSAL.OCTET_STRING, 'extension value').content;
  }
  return null;
}

/** An AuthorizationList as tag number → inner value. */
function authList(n: Der): Map<number, Der> {
  const m = new Map<number, Der>();
  for (const item of children(expect(n, UNIVERSAL.SEQUENCE, 'authorization list'))) {
    if (item.cls !== 2 || !item.constructed) throw new AttestationError('malformed', 'Attestation record: bad authorization entry.');
    if (m.has(item.tag)) throw new AttestationError('malformed', 'Attestation record: repeated authorization entry.');
    m.set(item.tag, parseOne(item.content));
  }
  return m;
}

const SECURITY = ['software', 'tee', 'strongbox'] as const;
const BOOT = ['verified', 'self_signed', 'unverified', 'failed'] as const;

export interface KeyDescription {
  attestationVersion: number;
  securityLevel: (typeof SECURITY)[number];
  challenge: Buffer;
  rootOfTrust: { deviceLocked: boolean; verifiedBootState: (typeof BOOT)[number] } | null;
  packages: string[];
  signatureDigests: string[];
  osPatchLevel: number | null;
}

export function parseKeyDescription(der: Buffer): KeyDescription {
  const kd = children(expect(parseOne(der), UNIVERSAL.SEQUENCE, 'key description'));
  if (kd.length < 8) throw new AttestationError('malformed', 'Attestation record is incomplete.');
  const attestationVersion = int(kd[0], 'version');
  const level = int(kd[1], 'security level', UNIVERSAL.ENUMERATED);
  const challenge = Buffer.from(expect(kd[4], UNIVERSAL.OCTET_STRING, 'challenge').content);
  const sw = authList(kd[6]!);
  const hw = authList(kd[7]!);

  // Root of trust: only believed when the secure hardware reports it.
  let rootOfTrust: KeyDescription['rootOfTrust'] = null;
  const rot = hw.get(704);
  if (rot) {
    const r = children(expect(rot, UNIVERSAL.SEQUENCE, 'root of trust'));
    const locked = expect(r[1], UNIVERSAL.BOOLEAN, 'device locked').content;
    const state = int(r[2], 'boot state', UNIVERSAL.ENUMERATED);
    rootOfTrust = { deviceLocked: locked.length === 1 && locked[0] !== 0, verifiedBootState: BOOT[state] ?? 'failed' };
  }

  // Which app made the key (written by Android's keystore service).
  const packages: string[] = [];
  const signatureDigests: string[] = [];
  const appId = sw.get(709) ?? hw.get(709);
  if (appId) {
    const app = children(expect(parseOne(expect(appId, UNIVERSAL.OCTET_STRING, 'application id').content), UNIVERSAL.SEQUENCE, 'application id'));
    for (const info of children(expect(app[0], UNIVERSAL.SET, 'package list'))) {
      const p = children(expect(info, UNIVERSAL.SEQUENCE, 'package'));
      packages.push(expect(p[0], UNIVERSAL.OCTET_STRING, 'package name').content.toString('utf8'));
    }
    for (const d of children(expect(app[1], UNIVERSAL.SET, 'signature digests'))) signatureDigests.push(expect(d, UNIVERSAL.OCTET_STRING, 'signature digest').content.toString('hex'));
  }
  const patch = hw.get(706) ?? sw.get(706);
  return {
    attestationVersion,
    securityLevel: SECURITY[level] ?? 'software',
    challenge,
    rootOfTrust,
    packages,
    signatureDigests,
    osPatchLevel: patch ? int(patch, 'patch level') : null,
  };
}

// ───────────────────────────── the chain ─────────────────────────────

const pinnedRoots = (pems: readonly string[]) => pems.map((p) => new X509Certificate(p).publicKey.export({ type: 'spki', format: 'der' }));
const GOOGLE_ROOT_KEYS = pinnedRoots(GOOGLE_ATTESTATION_ROOTS);

/** "0A1B" → "a1b" (how Google's revocation list writes serial numbers). */
export const serialKey = (hex: string) => hex.toLowerCase().replace(/^0+(?=.)/, '');

export interface AttestationPolicy {
  challenge: Buffer;
  /** Android package names allowed to own the key. */
  packages: readonly string[];
  /** SHA-256 of the app signing certificate(s), hex; empty = don't check. */
  signingCertDigests?: readonly string[];
  /** Serial numbers (serialKey form) revoked by Google. */
  revoked?: ReadonlySet<string>;
  /** Test roots (PEM). Production always uses Google's. */
  roots?: readonly string[];
}

export function verifyAndroidAttestation(chainB64: readonly string[], policy: AttestationPolicy): AttestationResult {
  if (!Array.isArray(chainB64) || chainB64.length < 2 || chainB64.length > 10) throw new AttestationError('chain', 'The attestation chain has the wrong length.');
  let certs: X509Certificate[];
  try {
    certs = chainB64.map((b) => new X509Certificate(Buffer.from(b, 'base64')));
  } catch {
    throw new AttestationError('malformed', 'The attestation chain could not be read.');
  }
  for (let i = 0; i < certs.length - 1; i++)
    if (!certs[i]!.verify(certs[i + 1]!.publicKey)) throw new AttestationError('chain', 'The attestation chain is broken (a signature does not match).');
  const root = certs[certs.length - 1]!;
  const rootKey = root.publicKey.export({ type: 'spki', format: 'der' });
  const trusted = policy.roots ? pinnedRoots(policy.roots) : GOOGLE_ROOT_KEYS;
  if (!root.verify(root.publicKey) || !trusted.some((k) => k.equals(rootKey))) throw new AttestationError('root', 'The attestation does not come from Google’s hardware roots.');
  if (policy.revoked?.size) for (const c of certs) if (policy.revoked.has(serialKey(c.serialNumber))) throw new AttestationError('revoked', 'This phone’s attestation certificate was revoked by Google.');

  const leafDer = Buffer.from(chainB64[0]!, 'base64');
  const ext = extensionValue(leafDer, KEY_DESCRIPTION_OID);
  if (!ext) throw new AttestationError('malformed', 'The key has no Android attestation record.');
  const kd = parseKeyDescription(ext);

  if (kd.challenge.length !== policy.challenge.length || !kd.challenge.equals(policy.challenge)) throw new AttestationError('challenge', 'The attestation is not for this sign-in.');
  if (kd.securityLevel === 'software') throw new AttestationError('software', 'This phone has no secure hardware for keys (or it is an emulator).');
  if (!kd.rootOfTrust || kd.rootOfTrust.verifiedBootState !== 'verified' || !kd.rootOfTrust.deviceLocked)
    throw new AttestationError('boot', 'This phone’s bootloader is unlocked or it runs modified system software (rooted / custom ROM).');
  // Very old keystores omit the app ID: unverifiable, but not evidence of tampering.
  if (!kd.packages.length) throw new AttestationError('malformed', 'The attestation does not say which app made the key.');
  const pkg = kd.packages.find((p) => policy.packages.includes(p));
  if (!pkg) throw new AttestationError('package', 'The key was not made by the official Attendly app.');
  const want = (policy.signingCertDigests ?? []).map((d) => d.toLowerCase().replace(/[^0-9a-f]/g, ''));
  if (want.length && !kd.signatureDigests.some((d) => want.includes(d))) throw new AttestationError('signing_cert', 'This copy of the app is not signed by Attendly.');

  const key = certs[0]!.publicKey;
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new AttestationError('key', 'Unexpected hardware key type.');
  return {
    securityLevel: kd.securityLevel,
    deviceLocked: kd.rootOfTrust.deviceLocked,
    verifiedBootState: kd.rootOfTrust.verifiedBootState,
    packageName: pkg,
    signatureDigests: kd.signatureDigests,
    keySpki: key.export({ type: 'spki', format: 'der' }),
    osPatchLevel: kd.osPatchLevel,
    attestationVersion: kd.attestationVersion,
  };
}

/** Checks a signature made by the phone's hardware key (ECDSA P-256, SHA-256, DER). */
export function verifyHardwareSignature(spki: Buffer, data: Buffer | string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return cryptoVerify('sha256', Buffer.isBuffer(data) ? data : Buffer.from(data), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** The attestation challenge for a bind ticket (the app computes the same from the protocol). */
export const bindChallenge = (ticket: string) => createHash('sha256').update(attestBindChallengeString(ticket)).digest();
