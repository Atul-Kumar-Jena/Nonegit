/**
 * Phone trust policy on top of Android key attestation (lib/attestation.ts).
 *
 *  • A phone that sends an attestation must pass it — a Google-signed statement that the phone is
 *    rooted, unlocked or running a clone of the app is always refused, whatever the settings.
 *  • Whether every Android phone *must* have a hardware key is a platform setting
 *    (REQUIRE_HARDWARE_KEYS) or a per-institution flag (hardware_binding).
 *  • Google's revocation list (leaked attestation keys) is refreshed in the background.
 */
import type { Queryable } from '../db';
import type { Deps } from '../deps';
import { ApiError } from './errors';
import { tenantFlag } from './flags';
import { AttestationError, verifyAndroidAttestation, type AttestationResult } from './attestation';

export const ATTEST_PACKAGES = ['app.attendly.student', 'app.attendly.institute'] as const;
const REVOCATION_URL = 'https://android.googleapis.com/attestation/status';

let revoked: ReadonlySet<string> = new Set();
let revokedAt = 0;

/** Test hook / manual refresh. */
/**
 * Google's feed mixes hex serials (newer) with decimal ones (older entries, e.g. "6681152659205225093").
 * Each entry is indexed under both readings, as normalised hex; a false match between the two is
 * practically impossible for real (random, 64–128-bit) serial numbers.
 */
export function setRevokedSerials(serials: Iterable<string>) {
  const out = new Set<string>();
  for (const raw of serials) {
    const s = raw.trim().toLowerCase();
    if (/^[0-9a-f]+$/.test(s)) out.add(s.replace(/^0+(?=.)/, ''));
    if (/^[0-9]+$/.test(s)) out.add(BigInt(s).toString(16));
  }
  revoked = out;
  revokedAt = Date.now();
}
export const revocationListAge = () => (revokedAt ? Date.now() - revokedAt : null);

export async function refreshRevocations(fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(REVOCATION_URL, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`revocation list HTTP ${res.status}`);
  const json = (await res.json()) as { entries?: Record<string, { status?: string }> };
  if (!json.entries || typeof json.entries !== 'object') throw new Error('revocation list: unexpected format');
  // Every listed status (REVOKED, SUSPENDED) means "don't trust this key".
  setRevokedSerials(Object.keys(json.entries));
  return revoked.size;
}

/** Refreshes Google's revocation list now and every 6 hours. */
export function startRevocationRefresh(log: (msg: string) => void): () => void {
  const run = () =>
    refreshRevocations()
      .then((n) => log(`attestation revocation list: ${n} entries`))
      .catch((err: Error) => log(`attestation revocation list refresh failed (keeping the previous list): ${err.message}`));
  void run();
  const t = setInterval(run, 6 * 3_600_000);
  t.unref();
  return () => clearInterval(t);
}

/** Must this user's Android phone have an attested hardware key? */
export async function hardwareRequired(db: Queryable, deps: Deps, tenantId: string, platform: string): Promise<boolean> {
  if (platform !== 'android') return false;
  return deps.config.attestation.requireHardware || (await tenantFlag(db, tenantId, 'hardware_binding', deps.config));
}

const USER_MESSAGE: Record<AttestationError['code'], string> = {
  malformed: 'This phone’s security chip gave an unreadable answer. Update Android and the app, then try again.',
  chain: 'This phone’s security certificate could not be verified.',
  root: 'This phone’s security certificate could not be verified.',
  revoked: 'Google has revoked this phone’s security certificate, so it can’t be trusted for attendance.',
  challenge: 'The security check expired. Please sign in again.',
  software: 'This phone has no secure hardware for keys (or it’s an emulator), so it can’t be bound.',
  boot: 'This phone is rooted, its bootloader is unlocked, or it runs modified system software. Attendance needs an unmodified phone.',
  package: 'This isn’t the official Attendly app. Install it from your institution’s link.',
  signing_cert: 'This isn’t the official Attendly app. Install it from your institution’s link.',
  key: 'This phone’s secure key has an unexpected type.',
};

/** Failures that prove the phone or app is tampered with — refused even when hardware keys are optional. */
const TAMPERED: ReadonlySet<AttestationError['code']> = new Set(['boot', 'package', 'signing_cert', 'revoked']);

export const isTamperEvidence = (code: string) => TAMPERED.has(code as AttestationError['code']);

export interface VerifiedHardware {
  spki: Buffer;
  level: 'tee' | 'strongbox';
  patch: number | null;
}

/**
 * Checks a phone's attestation for this challenge.
 * Returns the verified key, or null when the phone sent none / its hardware couldn't be verified and
 * hardware keys are optional. Throws when the phone is proven tampered with, or when a key is required.
 */
export function checkAttestation(
  deps: Deps,
  chain: readonly string[] | undefined,
  challenge: Buffer,
  required: boolean,
  /** Developer emergency switch: never refuse on a failed check. */
  relaxed: boolean,
  audit: (code: string, detail: string) => void,
): VerifiedHardware | null {
  if (!chain) {
    if (required) throw new ApiError(403, 'INTEGRITY', 'Your institution requires a phone with a secure hardware key. Update the Attendly app and sign in again.');
    return null;
  }
  let r: AttestationResult;
  try {
    r = verifyAndroidAttestation(chain, {
      challenge,
      packages: ATTEST_PACKAGES,
      signingCertDigests: deps.config.attestation.appCertDigests,
      revoked,
      ...(deps.config.attestation.testRoots ? { roots: deps.config.attestation.testRoots } : {}),
    });
  } catch (err) {
    if (!(err instanceof AttestationError)) throw err;
    audit(err.code, err.message);
    if (!relaxed && (required || TAMPERED.has(err.code))) throw new ApiError(403, 'INTEGRITY', USER_MESSAGE[err.code]);
    return null;
  }
  return { spki: r.keySpki, level: r.securityLevel, patch: r.osPatchLevel };
}
