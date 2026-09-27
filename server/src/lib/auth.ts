import type { FastifyRequest } from 'fastify';
import {
  fromB64url,
  isB64urlOfLength,
  requestSigningString,
  sha256Hex,
  verify,
  type AuthTokens,
  type Role,
} from '@attendly/protocol';
import type { Queryable } from '../db';
import type { Deps } from '../deps';
import { verifyHardwareSignature } from './attestation';
import { ApiError, unauthenticated } from './errors';
import { randomToken } from './secrets';

export const ACCESS_TTL_MS = 15 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/**
 * Absolute lifetime of one sign-in, however often it is refreshed. Staff hold
 * powers over other people's records, so they re-verify with a code every day.
 */
export const STUDENT_LOGIN_MAX_MS = 180 * 24 * 60 * 60_000;
export const STAFF_LOGIN_MAX_MS = 16 * 60 * 60_000;

export function loginLifetimeMs(role: Role): number {
  return role === 'student' ? STUDENT_LOGIN_MAX_MS : STAFF_LOGIN_MAX_MS;
}
/** Allowed difference between the device's (server-corrected) clock and ours. */
export const MAX_CLOCK_SKEW_MS = 90_000;
/** Nonces are remembered for longer than the skew window, so a replay is always caught. */
const NONCE_TTL_MS = 2 * MAX_CLOCK_SKEW_MS + 30_000;
/** A retried refresh (lost response) within this window re-issues instead of tripping reuse detection. */
const REFRESH_RETRY_GRACE_MS = 60_000;

/**
 * Rate-limit key for authenticated routes: one bucket per access token (i.e. per
 * device session), so students sharing a campus NAT never throttle each other.
 */
export function perDeviceKey(req: FastifyRequest): string {
  const a = req.headers.authorization;
  return typeof a === 'string' && a.startsWith('Bearer ') ? `tok:${sha256Hex(a).slice(0, 32)}` : `ip:${req.ip}`;
}

export const HDR_TS = 'x-attendly-ts';
export const HDR_NONCE = 'x-attendly-nonce';
export const HDR_SIG = 'x-attendly-sig';
/** ECDSA P-256 signature over the same request string, made inside the phone's security chip. */
export const HDR_HWSIG = 'x-attendly-hwsig';

export interface AuthContext {
  sessionId: string;
  familyId: string;
  userId: string;
  role: Role;
  /** Professors: extra powers an admin gave them (see lib/access.ts `can`). */
  permissions: string[];
  tenantId: string;
  deviceId: string;
  devicePublicKey: Buffer;
  deviceFingerprint: string;
  /** Raw device signature over this request — kept as evidence for attendance marks. */
  signature: Buffer;
  /** SHA-256 of the signed request string. */
  requestDigest: Buffer;
  devicePlatform: string;
  /** The phone's attested security-chip key (null: software key only). */
  hardwareKey: Buffer | null;
  /** This request also carries a valid signature from that security-chip key. */
  hardwareSigned: boolean;
  /** Google's attestation proved this phone tampered with (rooted / unlocked / clone app). */
  attestFailure: string | null;
}

export async function issueTokens(
  tx: Queryable,
  deps: Deps,
  p: { userId: string; deviceId: string; familyId?: string; parentId?: string; familyExpiresAt?: Date },
): Promise<AuthTokens> {
  const now = deps.clock();
  let familyExpiresAt = p.familyExpiresAt;
  if (!familyExpiresAt) {
    const { rows } = await tx.query<{ role: Role }>('select role from users where id = $1', [p.userId]);
    familyExpiresAt = new Date(now + loginLifetimeMs(rows[0]?.role ?? 'student'));
  }
  const cap = familyExpiresAt.getTime();
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const accessExpiresAt = new Date(Math.min(now + ACCESS_TTL_MS, cap));
  const refreshExpiresAt = new Date(Math.min(now + REFRESH_TTL_MS, cap));
  await tx.query(
    `insert into auth_sessions(family_id, parent_id, user_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, family_expires_at)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      p.familyId ?? null,
      p.parentId ?? null,
      p.userId,
      p.deviceId,
      deps.hash('access', accessToken),
      accessExpiresAt,
      deps.hash('refresh', refreshToken),
      refreshExpiresAt,
      familyExpiresAt,
    ],
  );
  return {
    accessToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshToken,
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/** Raw request body exactly as received (set by the JSON content-type parser). */
export function rawBody(req: FastifyRequest): string {
  return (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
}

/**
 * Verifies the device signature on a request (proof-of-possession of the
 * device key) and consumes its nonce. Throws ApiError on any failure.
 */
async function verifyDeviceSignature(
  db: Queryable,
  deps: Deps,
  req: FastifyRequest,
  device: { id: string; publicKey: Buffer },
): Promise<{ signature: Buffer; requestDigest: Buffer; signing: string }> {
  const tsStr = header(req, HDR_TS);
  const nonce = header(req, HDR_NONCE);
  const sigB64 = header(req, HDR_SIG);
  if (!tsStr || !nonce || !sigB64) throw new ApiError(401, 'BAD_SIGNATURE', 'Missing request signature.');
  if (!/^[0-9]{10,16}$/.test(tsStr) || !isB64urlOfLength(nonce, 16) || !isB64urlOfLength(sigB64, 64))
    throw new ApiError(401, 'BAD_SIGNATURE', 'Malformed request signature.');

  const now = deps.clock();
  const ts = Number(tsStr);
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) throw new ApiError(401, 'CLOCK_SKEW', undefined, { serverTime: now });

  const signing = requestSigningString({
    method: req.method,
    pathWithQuery: req.url,
    timestampMs: ts,
    nonce,
    bodySha256Hex: sha256Hex(rawBody(req)),
  });
  const signature = Buffer.from(fromB64url(sigB64));
  if (!verify(signature, signing, device.publicKey)) throw new ApiError(401, 'BAD_SIGNATURE');

  const inserted = await db.query(
    `insert into request_nonces(device_id, nonce, expires_at) values ($1, $2, $3) on conflict do nothing`,
    [device.id, nonce, new Date(now + NONCE_TTL_MS)],
  );
  if (inserted.rowCount !== 1) throw new ApiError(401, 'REPLAY');
  return { signature, requestDigest: Buffer.from(sha256Hex(signing), 'hex'), signing };
}

interface SessionRow {
  session_id: string;
  family_id: string;
  user_id: string;
  role: Role;
  permissions: string[];
  tenant_id: string;
  device_id: string;
  public_key: Buffer;
  fingerprint: string;
  platform: string;
  hw_key_spki: Buffer | null;
  attest_failure: string | null;
  device_status: 'active' | 'revoked';
  user_status: 'active' | 'suspended';
  tenant_status: 'active' | 'suspended';
  access_expires_at: Date;
  revoked_at: Date | null;
  rotated_at: Date | null;
  last_used_at: Date | null;
}

const SESSION_SELECT = `
  select s.id as session_id, s.family_id, s.user_id, u.role, u.permissions, u.tenant_id, s.device_id,
         d.public_key, d.fingerprint, d.platform, d.hw_key_spki, d.attest_failure, d.status as device_status, u.status as user_status,
         t.status as tenant_status, s.access_expires_at, s.revoked_at, s.rotated_at, s.last_used_at
    from auth_sessions s
    join devices d on d.id = s.device_id
    join users u on u.id = s.user_id
    join tenants t on t.id = u.tenant_id`;

/**
 * Authenticates a request: bearer access token + device signature.
 * Optionally restricts to specific roles.
 */
export async function requireDevice(req: FastifyRequest, deps: Deps, roles?: readonly Role[]): Promise<AuthContext> {
  const authz = header(req, 'authorization');
  const token = authz?.startsWith('Bearer ') ? authz.slice(7) : undefined;
  if (!token || !isB64urlOfLength(token, 32)) throw unauthenticated();

  const { rows } = await deps.db.query<SessionRow>(`${SESSION_SELECT} where s.access_hash = $1`, [deps.hash('access', token)]);
  const s = rows[0];
  if (!s) throw unauthenticated();
  // Report an unbound phone as such (its sessions are revoked with it) so the app can say why.
  if (s.device_status !== 'active') throw new ApiError(401, 'DEVICE_REVOKED');
  if (s.revoked_at) throw unauthenticated();
  if (s.user_status !== 'active' || s.tenant_status !== 'active') throw new ApiError(403, 'ACCOUNT_SUSPENDED');

  const now = deps.clock();
  // Verify possession of the device key *before* telling the caller anything about token expiry.
  const { signature, requestDigest, signing } = await verifyDeviceSignature(deps.db, deps, req, { id: s.device_id, publicKey: s.public_key });
  const hwSig = header(req, HDR_HWSIG);
  const hardwareSigned = !!(s.hw_key_spki && hwSig && hwSig.length <= 200 && verifyHardwareSignature(s.hw_key_spki, signing, hwSig));
  if (s.access_expires_at.getTime() <= now || s.rotated_at) throw new ApiError(401, 'TOKEN_EXPIRED');
  if (roles && !roles.includes(s.role)) throw new ApiError(403, 'FORBIDDEN');

  if (!s.last_used_at || now - s.last_used_at.getTime() > 60_000) {
    await deps.db.query('update auth_sessions set last_used_at = $2 where id = $1', [s.session_id, new Date(now)]);
    await deps.db.query('update devices set last_seen_at = $2 where id = $1', [s.device_id, new Date(now)]);
  }

  return {
    sessionId: s.session_id,
    familyId: s.family_id,
    userId: s.user_id,
    role: s.role,
    permissions: s.permissions ?? [],
    tenantId: s.tenant_id,
    deviceId: s.device_id,
    devicePublicKey: s.public_key,
    deviceFingerprint: s.fingerprint,
    signature,
    requestDigest,
    devicePlatform: s.platform,
    hardwareKey: s.hw_key_spki,
    hardwareSigned,
    attestFailure: s.attest_failure,
  };
}

/**
 * Device-key-only authentication, for one read-only purpose: a phone checking for
 * new notifications in the background, without touching login tokens (so it can
 * never race the app's own token refresh). The request must be signed by an
 * active device key whose owner is still signed in on it.
 */
export async function requireDeviceKeyOnly(req: FastifyRequest, deps: Deps): Promise<{ userId: string; tenantId: string; deviceId: string }> {
  const keyB64 = header(req, 'x-attendly-key');
  if (!keyB64 || !isB64urlOfLength(keyB64, 32)) throw unauthenticated();
  const { rows } = await deps.db.query<{ id: string; public_key: Buffer; user_id: string; tenant_id: string; user_status: string; tenant_status: string }>(
    `select d.id, d.public_key, d.user_id, u.tenant_id, u.status as user_status, t.status as tenant_status
       from devices d join users u on u.id = d.user_id join tenants t on t.id = u.tenant_id
      where d.public_key = $1 and d.status = 'active'`,
    [Buffer.from(fromB64url(keyB64))],
  );
  const d = rows[0];
  if (!d) throw unauthenticated();
  await verifyDeviceSignature(deps.db, deps, req, { id: d.id, publicKey: d.public_key });
  if (d.user_status !== 'active' || d.tenant_status !== 'active') throw new ApiError(403, 'ACCOUNT_SUSPENDED');
  const now = new Date(deps.clock());
  const live = await deps.db.query(
    `select 1 from auth_sessions where device_id = $1 and user_id = $2 and revoked_at is null and family_expires_at > $3 and refresh_expires_at > $3 limit 1`,
    [d.id, d.user_id, now],
  );
  if (!live.rowCount) throw unauthenticated('Signed out on this phone.');
  return { userId: d.user_id, tenantId: d.tenant_id, deviceId: d.id };
}

interface RefreshRow extends SessionRow {
  refresh_expires_at: Date;
  family_expires_at: Date;
}

/**
 * Rotates a refresh token. Presenting an already-rotated refresh token
 * (outside the short retry grace window) revokes the whole token family.
 */
export async function rotateRefreshToken(req: FastifyRequest, deps: Deps, refreshToken: string): Promise<AuthTokens> {
  const client = await deps.db.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<RefreshRow>(
      `${SESSION_SELECT.replace('s.last_used_at', 's.last_used_at, s.refresh_expires_at, s.family_expires_at')} where s.refresh_hash = $1 for update of s`,
      [deps.hash('refresh', refreshToken)],
    );
    const s = rows[0];
    if (!s) throw unauthenticated();
    if (s.device_status !== 'active') throw new ApiError(401, 'DEVICE_REVOKED');
    if (s.revoked_at) throw unauthenticated();
    if (s.user_status !== 'active' || s.tenant_status !== 'active') throw new ApiError(403, 'ACCOUNT_SUSPENDED');

    await verifyDeviceSignature(client, deps, req, { id: s.device_id, publicKey: s.public_key });
    const now = deps.clock();
    if (s.refresh_expires_at.getTime() <= now || s.family_expires_at.getTime() <= now) throw unauthenticated('Session expired. Please sign in again.');

    if (s.rotated_at) {
      if (now - s.rotated_at.getTime() > REFRESH_RETRY_GRACE_MS) {
        await client.query(
          `update auth_sessions set revoked_at = $2, revoke_reason = 'refresh_reuse' where family_id = $1 and revoked_at is null`,
          [s.family_id, new Date(now)],
        );
        await client.query('commit');
        req.log.warn({ family: s.family_id, user: s.user_id }, 'refresh token reuse detected — family revoked');
        throw unauthenticated('Session revoked for your security. Please sign in again.');
      }
      // Legitimate retry by the same device: retire the child issued moments ago and issue a fresh pair.
      await client.query(
        `update auth_sessions set revoked_at = $2, revoke_reason = 'refresh_retry' where parent_id = $1 and revoked_at is null`,
        [s.session_id, new Date(now)],
      );
    } else {
      await client.query('update auth_sessions set rotated_at = $2 where id = $1', [s.session_id, new Date(now)]);
    }
    const tokens = await issueTokens(client, deps, {
      userId: s.user_id,
      deviceId: s.device_id,
      familyId: s.family_id,
      parentId: s.session_id,
      familyExpiresAt: s.family_expires_at,
    });
    await client.query('commit');
    return tokens;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
