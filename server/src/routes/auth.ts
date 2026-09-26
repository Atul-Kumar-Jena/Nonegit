import type { FastifyInstance } from 'fastify';
import {
  BindBody,
  DeviceInfo,
  OtpRequestBody,
  OtpVerifyBody,
  RebindRequestBody,
  RefreshBody,
  bindProofString,
  fromB64url,
  isValidPublicKey,
  keyFingerprint,
  loginProofString,
  timingSafeEqual,
  verifyB64,
  type BindResponse,
  type DeviceRequestResponse,
  type OtpRequestResponse,
  type OtpVerifyResponse,
} from '@attendly/protocol';
import type { PoolClient } from 'pg';
import type { Deps } from '../deps';
import { isUniqueViolation, withTx } from '../db';
import { appendAudit } from '../lib/audit';
import { issueTokens, requireDevice, rotateRefreshToken } from '../lib/auth';
import { isDemoEmail } from '../lib/demo';
import { ApiError } from '../lib/errors';
import { generateOtpCode, maskEmail, maskPhone, randomToken } from '../lib/secrets';
import { revokeActiveDevice } from './staff-admin';
import { loadActiveDevice, loadUser, toDeviceSummary, toUserSummary, type DeviceRow } from '../lib/users';

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_AFTER_MS = 30_000;
export const OTP_MAX_PER_HOUR = 6;
export const TICKET_TTL_MS = 10 * 60_000;

/**
 * Per-IP flood guard for unauthenticated auth routes. Brute force is stopped by the
 * per-challenge attempt limit and per-identifier throttle, not by this; it is sized
 * so a class signing in together behind one campus NAT is never blocked.
 */
const strictLimit = { rateLimit: { max: 120, timeWindow: '1 minute' } };

function checkDeviceIntegrity(deps: Deps, device: DeviceInfo) {
  if (device.platform === 'web' && !deps.config.allowWebClients) throw new ApiError(403, 'INTEGRITY', 'Web clients are not allowed on this server.');
  if (device.integrity.rooted) throw new ApiError(403, 'INTEGRITY');
  if (device.integrity.emulator && !deps.config.allowEmulators) throw new ApiError(403, 'INTEGRITY', 'Emulators and simulators cannot be bound to an account.');
  if (!isValidPublicKey(fromB64url(device.publicKey))) throw new ApiError(400, 'BAD_REQUEST', 'Invalid device public key.');
}

async function createTicket(tx: PoolClient, deps: Deps, kind: 'bind' | 'rebind', userId: string, device: DeviceInfo): Promise<string> {
  const ticket = randomToken(32);
  await tx.query(
    `insert into auth_tickets(token_hash, kind, user_id, public_key, device_info, expires_at) values ($1, $2, $3, $4, $5, $6)`,
    [deps.hash('ticket', ticket), kind, userId, Buffer.from(fromB64url(device.publicKey)), JSON.stringify(device), new Date(deps.clock() + TICKET_TTL_MS)],
  );
  return ticket;
}

interface TicketRow {
  id: string;
  kind: 'bind' | 'rebind';
  user_id: string;
  public_key: Buffer;
  device_info: DeviceInfo;
  expires_at: Date;
  consumed_at: Date | null;
}

async function consumeTicket(tx: PoolClient, deps: Deps, ticket: string, kind: 'bind' | 'rebind', proof: string): Promise<TicketRow> {
  const { rows } = await tx.query<TicketRow>(`select * from auth_tickets where token_hash = $1 for update`, [deps.hash('ticket', ticket)]);
  const t = rows[0];
  if (!t || t.kind !== kind || t.consumed_at || t.expires_at.getTime() <= deps.clock()) throw new ApiError(401, 'TICKET_INVALID');
  const publicKeyB64 = DeviceInfo.shape.publicKey.parse(t.device_info.publicKey);
  if (!verifyB64(proof, bindProofString({ ticket, publicKeyB64, purpose: kind }), t.public_key)) throw new ApiError(401, 'BAD_SIGNATURE');
  await tx.query('update auth_tickets set consumed_at = $2 where id = $1', [t.id, new Date(deps.clock())]);
  return t;
}

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  // ── Step 1: request a one-time code ──────────────────────────────────────
  app.post('/v1/auth/otp/request', { config: strictLimit }, async (req): Promise<OtpRequestResponse> => {
    const body = OtpRequestBody.parse(req.body);
    const now = deps.clock();
    if (!deps.sender.supports(body.channel)) throw new ApiError(400, 'BAD_REQUEST', 'Phone sign-in is not enabled for this server. Use your institution email.');

    // Only people an admin has registered can receive a code — whatever their email domain.
    // The response is identical either way, so it never reveals who is registered.
    const col = body.channel === 'email' ? 'email' : 'phone';
    const u = await deps.db.query<{ id: string; status: string; tenant_status: string; tenant_name: string }>(
      `select u.id, u.status, t.status as tenant_status, t.name as tenant_name from users u join tenants t on t.id = u.tenant_id where u.${col} = $1`,
      [body.identifier],
    );
    const user = u.rows[0];
    const institution = user?.tenant_name ?? 'your institution';
    // Demo mode skips the code only for the seeded demo accounts; real accounts always get one.
    const instant = deps.config.demoInstantLogin && body.channel === 'email' && isDemoEmail(body.identifier);
    if (instant && !user) throw new ApiError(404, 'NOT_FOUND', 'That demo account does not exist on this server. Tap one of the listed demo accounts.');

    // Throttle per identifier (in addition to the per-IP limiter).
    const recent = await deps.db.query<{ n: number; last: Date | null }>(
      `select count(*) as n, max(created_at) as last from otp_challenges where identifier = $1 and created_at > $2`,
      [body.identifier, new Date(now - 3_600_000)],
    );
    const r = recent.rows[0]!;
    if (!instant && r.n >= OTP_MAX_PER_HOUR) throw new ApiError(429, 'RATE_LIMITED', 'Too many codes requested. Try again in an hour.');
    if (!instant && r.last && now - r.last.getTime() < OTP_RESEND_AFTER_MS)
      throw new ApiError(429, 'RATE_LIMITED', 'Please wait a few seconds before requesting another code.', {
        retryAfterSec: Math.ceil((OTP_RESEND_AFTER_MS - (now - r.last.getTime())) / 1000),
      });

    // Unknown or suspended users get an indistinguishable response, but no code is ever sent.
    const eligible = user && user.status === 'active' && user.tenant_status === 'active';
    const code = generateOtpCode();
    const expiresAt = new Date(now + OTP_TTL_MS);
    const { rows } = await deps.db.query<{ id: string }>(
      `insert into otp_challenges(user_id, channel, identifier, code_hash, expires_at, request_ip, created_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [eligible ? user!.id : null, body.channel, body.identifier, deps.hash('otp', `${body.identifier}:${code}`), expiresAt, req.ip, new Date(now)],
    );
    const challengeId = rows[0]!.id;
    if (eligible && !instant) {
      // Not awaited: response time must not reveal whether the account exists.
      deps.sender
        .send({ channel: body.channel, to: body.identifier, code, institution })
        .catch((err: Error) => req.log.error({ err: err.message, challengeId }, 'OTP delivery failed'));
    }
    return {
      challengeId,
      expiresAt: expiresAt.toISOString(),
      resendAfterSec: OTP_RESEND_AFTER_MS / 1000,
      destination: body.channel === 'email' ? maskEmail(body.identifier) : maskPhone(body.identifier),
      ...(instant && eligible ? { instantCode: code } : {}),
    };
  });

  // ── Step 2: verify the code and prove possession of the device key ──────
  app.post('/v1/auth/otp/verify', { config: strictLimit }, async (req): Promise<OtpVerifyResponse> => {
    const body = OtpVerifyBody.parse(req.body);
    if (!verifyB64(body.proof, loginProofString({ challengeId: body.challengeId, publicKeyB64: body.device.publicKey }), fromB64url(body.device.publicKey)))
      throw new ApiError(401, 'BAD_SIGNATURE');
    checkDeviceIntegrity(deps, body.device);

    // Attempt counting must survive a wrong code, so it is committed separately.
    const verdict = await withTx(deps.db, async (tx) => {
      const { rows } = await tx.query<{ id: string; user_id: string | null; identifier: string; code_hash: Buffer; attempts: number; expires_at: Date; consumed_at: Date | null }>(
        `select id, user_id, identifier, code_hash, attempts, expires_at, consumed_at from otp_challenges where id = $1 for update`,
        [body.challengeId],
      );
      const c = rows[0];
      if (!c) return { error: new ApiError(400, 'OTP_EXPIRED') };
      if (c.consumed_at || c.expires_at.getTime() <= deps.clock()) return { error: new ApiError(400, 'OTP_EXPIRED') };
      if (c.attempts >= OTP_MAX_ATTEMPTS) return { error: new ApiError(429, 'OTP_LOCKED') };
      const ok = timingSafeEqual(deps.hash('otp', `${c.identifier}:${body.code}`), c.code_hash) && c.user_id !== null;
      if (!ok) {
        await tx.query('update otp_challenges set attempts = attempts + 1 where id = $1', [c.id]);
        const left = OTP_MAX_ATTEMPTS - c.attempts - 1;
        return { error: left > 0 ? new ApiError(400, 'OTP_INVALID', `That code is incorrect. ${left} attempt${left === 1 ? '' : 's'} left.`) : new ApiError(429, 'OTP_LOCKED') };
      }
      await tx.query('update otp_challenges set consumed_at = $2 where id = $1', [c.id, new Date(deps.clock())]);
      return { userId: c.user_id! };
    });
    if ('error' in verdict) throw verdict.error;

    const user = await loadUser(deps.db, verdict.userId);
    if (!user || user.status !== 'active' || user.tenant_status !== 'active') throw new ApiError(403, 'ACCOUNT_SUSPENDED');

    const pk = Buffer.from(fromB64url(body.device.publicKey));
    return withTx(deps.db, async (tx): Promise<OtpVerifyResponse> => {
      let bound = await loadActiveDevice(tx, user.id);
      // Demo accounts hop between test phones: the new phone simply takes over.
      if (bound && !bound.public_key.equals(pk) && deps.config.demoInstantLogin && isDemoEmail(user.email)) {
        await revokeActiveDevice(tx, user.id, 'demo: signed in on another phone', new Date(deps.clock()));
        await appendAudit(tx, { tenantId: user.tenant_id, actorType: 'user', actorId: user.id, action: 'device.demo_handover', subject: `device:${bound.id}` });
        bound = undefined;
      }
      if (!bound) {
        const ticket = await createTicket(tx, deps, 'bind', user.id, body.device);
        return { status: 'bind_required', ticket, user: toUserSummary(user) };
      }
      if (bound.public_key.equals(pk)) {
        await tx.query(
          `update devices set os_version = $2, app_version = $3, model = $4, last_seen_at = $5 where id = $1`,
          [bound.id, body.device.osVersion, body.device.appVersion, body.device.model, new Date(deps.clock())],
        );
        const auth = await issueTokens(tx, deps, { userId: user.id, deviceId: bound.id });
        await appendAudit(tx, { tenantId: user.tenant_id, actorType: 'user', actorId: user.id, action: 'auth.login', subject: `device:${bound.id}` });
        return { status: 'ok', auth, user: toUserSummary(user), device: toDeviceSummary({ ...bound, last_seen_at: new Date(deps.clock()) }) };
      }
      const ticket = await createTicket(tx, deps, 'rebind', user.id, body.device);
      const pending = await tx.query<{ id: string; created_at: Date }>(
        `select id, created_at from device_requests where user_id = $1 and status = 'pending' and kind = 'rebind' and to_public_key = $2`,
        [user.id, pk],
      );
      await appendAudit(tx, {
        tenantId: user.tenant_id,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.device_mismatch',
        subject: `device:${bound.id}`,
        data: { attempted: keyFingerprint(pk), bound: bound.fingerprint },
      });
      return {
        status: 'device_mismatch',
        ticket,
        user: toUserSummary(user),
        boundDevice: { model: bound.model, platform: bound.platform, fingerprint: bound.fingerprint, boundAt: bound.bound_at?.toISOString() ?? null },
        pendingRequest: pending.rows[0] ? { id: pending.rows[0].id, createdAt: pending.rows[0].created_at.toISOString() } : null,
      };
    });
  });

  // ── Step 3a: bind this phone (first device) ──────────────────────────────
  app.post('/v1/devices/bind', { config: strictLimit }, async (req): Promise<BindResponse> => {
    const body = BindBody.parse(req.body);
    try {
      return await withTx(deps.db, async (tx) => {
        const t = await consumeTicket(tx, deps, body.ticket, 'bind', body.proof);
        const user = await loadUser(tx, t.user_id);
        if (!user || user.status !== 'active' || user.tenant_status !== 'active') throw new ApiError(403, 'ACCOUNT_SUSPENDED');
        if (await loadActiveDevice(tx, user.id)) throw new ApiError(409, 'CONFLICT', 'Another device was bound to this account in the meantime.');
        if (deps.config.demoInstantLogin && isDemoEmail(user.email)) {
          // Demo: this phone may have been used for another demo account; free it.
          const other = await tx.query<{ user_id: string; email: string | null }>(
            `select d.user_id, u.email from devices d join users u on u.id = d.user_id where d.public_key = $1 and d.status = 'active'`,
            [t.public_key],
          );
          const o = other.rows[0];
          if (o && isDemoEmail(o.email)) await revokeActiveDevice(tx, o.user_id, 'demo: phone used for another demo account', new Date(deps.clock()));
        }
        const info = t.device_info;
        const { rows } = await tx.query<DeviceRow>(
          `insert into devices(user_id, public_key, fingerprint, platform, model, os_version, app_version, status, bound_at, last_seen_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $8) returning *`,
          [user.id, t.public_key, keyFingerprint(t.public_key), info.platform, info.model, info.osVersion, info.appVersion, new Date(deps.clock())],
        );
        const device = rows[0]!;
        const auth = await issueTokens(tx, deps, { userId: user.id, deviceId: device.id });
        await appendAudit(tx, {
          tenantId: user.tenant_id,
          actorType: 'user',
          actorId: user.id,
          action: 'device.bind',
          subject: `device:${device.id}`,
          data: { fingerprint: device.fingerprint, platform: device.platform, model: device.model },
        });
        return { auth, user: toUserSummary(user), device: toDeviceSummary(device) };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'devices_one_active_per_key')) throw new ApiError(409, 'CONFLICT', 'This phone is already registered to another account.');
      if (isUniqueViolation(err, 'devices_one_active_per_user')) throw new ApiError(409, 'CONFLICT', 'Another device was bound to this account in the meantime.');
      throw err;
    }
  });

  // ── Step 3b: new phone → ask an admin to approve the switch ──────────────
  app.post('/v1/devices/rebind-request', { config: strictLimit }, async (req): Promise<DeviceRequestResponse> => {
    const body = RebindRequestBody.parse(req.body);
    return withTx(deps.db, async (tx) => {
      const t = await consumeTicket(tx, deps, body.ticket, 'rebind', body.proof);
      const user = (await loadUser(tx, t.user_id))!;
      const bound = await loadActiveDevice(tx, user.id);
      const existing = await tx.query<{ id: string; kind: string; to_public_key: Buffer | null }>(
        `select id, kind, to_public_key from device_requests where user_id = $1 and status = 'pending' for update`,
        [user.id],
      );
      const prev = existing.rows[0];
      if (prev && prev.kind === 'rebind' && prev.to_public_key?.equals(t.public_key)) return { requestId: prev.id, status: 'pending' as const };
      if (prev) await tx.query(`update device_requests set status = 'cancelled', decided_at = $2 where id = $1`, [prev.id, new Date(deps.clock())]);
      const { rows } = await tx.query<{ id: string }>(
        `insert into device_requests(user_id, kind, from_device_id, to_public_key, to_device_info, reason)
         values ($1, 'rebind', $2, $3, $4, $5) returning id`,
        [user.id, bound?.id ?? null, t.public_key, JSON.stringify(t.device_info), body.reason],
      );
      await appendAudit(tx, {
        tenantId: user.tenant_id,
        actorType: 'user',
        actorId: user.id,
        action: 'device.rebind_request',
        subject: `request:${rows[0]!.id}`,
        data: { to: keyFingerprint(t.public_key), from: bound?.fingerprint ?? null },
      });
      return { requestId: rows[0]!.id, status: 'pending' as const };
    });
  });

  // Refreshes are signed by the device key, so a larger per-IP budget is safe (a whole
  // class's tokens can expire in the same minute behind one campus NAT).
  app.post('/v1/auth/refresh', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const body = RefreshBody.parse(req.body);
    return rotateRefreshToken(req, deps, body.refreshToken);
  });

  app.post('/v1/auth/logout', async (req) => {
    const auth = await requireDevice(req, deps);
    await deps.db.query(
      `update auth_sessions set revoked_at = $2, revoke_reason = 'logout' where family_id = $1 and revoked_at is null`,
      [auth.familyId, new Date(deps.clock())],
    );
    return { ok: true };
  });
}

