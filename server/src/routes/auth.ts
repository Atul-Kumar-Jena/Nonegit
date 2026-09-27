import type { FastifyInstance } from 'fastify';
import {
  InstitutionLookupQuery,
  type InstitutionLookup,
  AttestBody,
  BindBody,
  DeviceInfo,
  toB64url,
  type AttestStatusResponse,
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
import { insertNotifications } from '../lib/notify';
import { notifyDeviceRequest } from '../lib/mentors';
import type { Queryable } from '../db';
import { issueTokens, requireDevice, rotateRefreshToken } from '../lib/auth';
import { isDemoEmail } from '../lib/demo';
import { switchOn } from '../lib/flags';
import { makeSecretBox, verifyTotp } from '../lib/totp';
import { ApiError } from '../lib/errors';
import { generateOtpCode, maskEmail, maskPhone, randomToken } from '../lib/secrets';
import { revokeActiveDevice } from './staff-admin';
import { bindChallenge } from '../lib/attestation';
import { checkAttestation, hardwareRequired, isTamperEvidence, type VerifiedHardware } from '../lib/device-trust';
import { randomBytes } from 'node:crypto';
import { assertPhoneFree, hardwareHash, loadActiveDevice, loadUser, toDeviceSummary, toUserSummary, type DeviceRow } from '../lib/users';

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_AFTER_MS = 30_000;
export const OTP_MAX_PER_HOUR = 6;
/**
 * Wrong codes per account per 24 hours, across all its codes. Without it, 6 codes an hour × 5 tries
 * would allow 720 guesses a day; with it a 6-digit code can't realistically be guessed (10 in 10⁶).
 */
export const OTP_MAX_FAILURES_PER_DAY = 10;
/** The account owner is alerted at these counts of wrong codes. */
const OTP_ALERT_AT = [5, OTP_MAX_FAILURES_PER_DAY];

async function failuresToday(db: Queryable, identifier: string, now: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select coalesce(sum(attempts), 0)::int as n from otp_challenges where identifier = $1 and created_at > $2`, [
    identifier,
    new Date(now - 24 * 3_600_000),
  ]);
  return rows[0]!.n;
}
const lockedOut = () =>
  new ApiError(429, 'OTP_LOCKED', 'Too many wrong codes for this account today. For your safety, sign-in is locked for 24 hours — or ask your institution’s admin.');
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

/** Tells the account owner (on their phone) and the audit trail that someone is guessing their sign-in code. */
async function alertWrongCodes(tx: PoolClient, userId: string, count: number) {
  const u = (await tx.query<{ tenant_id: string }>('select tenant_id from users where id = $1', [userId])).rows[0];
  if (!u) return;
  const locked = count >= OTP_MAX_FAILURES_PER_DAY;
  await insertNotifications(tx, u.tenant_id, [
    {
      userId,
      kind: 'security',
      title: locked ? 'Sign-in locked for 24 hours' : 'Wrong sign-in codes for your account',
      body: locked
        ? `Someone entered ${count} wrong sign-in codes for your account, so sign-in is locked for a day. If it wasn’t you, tell your institution’s admin.`
        : `Someone entered ${count} wrong sign-in codes for your account today. If it wasn’t you, don’t share your codes and tell your institution’s admin.`,
      data: { count },
    },
  ]);
  await appendAudit(tx, { tenantId: u.tenant_id, actorType: 'system', actorId: null, action: locked ? 'auth.locked' : 'auth.wrong_codes', subject: `user:${userId}`, data: { count } });
}

/** Did this user's last phone prove a hardware key? Then the next one must too (no downgrade to a software key). */
async function hadHardwareKey(tx: PoolClient, userId: string): Promise<boolean> {
  const { rows } = await tx.query<{ hw: boolean }>(
    `select hw_key_spki is not null as hw from devices where user_id = $1 and platform = 'android' order by bound_at desc limit 1`,
    [userId],
  );
  return rows[0]?.hw ?? false;
}

/**
 * Verifies the attestation a phone sent with its bind ticket. Failures are logged to the audit trail
 * (outside the transaction, so a refused phone is still on record).
 */
async function attestForTicket(
  tx: PoolClient,
  deps: Deps,
  user: { id: string; tenant_id: string },
  platform: string,
  ticket: string,
  chain: readonly string[] | undefined,
): Promise<VerifiedHardware | null> {
  const required = (await hardwareRequired(tx, deps, user.tenant_id, platform)) || (platform === 'android' && (await hadHardwareKey(tx, user.id)));
  const relaxed = await switchOn(tx, 'hardware_checks_relaxed');
  return checkAttestation(deps, chain, bindChallenge(ticket), required && !relaxed, relaxed, (code, detail) => {
    // Its own transaction: the refusal is on record even though the binding is rolled back.
    void withTx(deps.db, (audit) =>
      appendAudit(audit, { tenantId: user.tenant_id, actorType: 'user', actorId: user.id, action: 'device.attest_failed', subject: `user:${user.id}`, data: { code, detail } }),
    ).catch((err: Error) => deps.log.error({ err: err.message }, 'failed to audit an attestation failure'));
  });
}

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  const box = makeSecretBox(deps.config.tokenPepper);
  // ── Step 1: request a one-time code ──────────────────────────────────────
  /** Institute app: "which institution is this code?" — public, but slow to enumerate. */
  app.get('/v1/institutions/lookup', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<InstitutionLookup> => {
    const { code } = InstitutionLookupQuery.parse(req.query);
    const { rows } = await deps.db.query<{ name: string; verified: boolean; status: string }>(
      'select name, verified_at is not null as verified, status from tenants where code = $1',
      [code],
    );
    const t = rows[0];
    if (!t) throw new ApiError(404, 'NOT_FOUND', 'No institution has that code. Check it with your institution’s admin.');
    return { code, name: t.name, verified: t.verified, active: t.status === 'active' };
  });

  app.post('/v1/auth/otp/request', { config: strictLimit }, async (req): Promise<OtpRequestResponse> => {
    const body = OtpRequestBody.parse(req.body);
    const now = deps.clock();
    if (!deps.sender.supports(body.channel)) throw new ApiError(400, 'BAD_REQUEST', 'Phone sign-in is not enabled for this server. Use your institution email.');

    // Only people an admin has registered can receive a code — whatever their email domain.
    // The response is identical either way, so it never reveals who is registered.
    const col = body.channel === 'email' ? 'email' : 'phone';
    const u = await deps.db.query<{ id: string; role: string; status: string; tenant_status: string; tenant_name: string; tenant_code: string; verified: boolean; totp: boolean }>(
      `select u.id, u.role, u.status, t.status as tenant_status, t.name as tenant_name, t.code as tenant_code,
              t.verified_at is not null as verified, u.totp_enabled_at is not null as totp
         from users u join tenants t on t.id = u.tenant_id where u.${col} = $1`,
      [body.identifier],
    );
    const user = u.rows[0];
    // Institute app: the account must belong to the institution whose code was entered.
    const rightInstitution = !body.institutionCode || user?.tenant_code === body.institutionCode;
    const institution = user?.tenant_name ?? 'your institution';
    // Platform maintenance switch (developers can still get in to turn it off).
    if (user?.role !== 'developer' && (await switchOn(deps.db, 'sign_ins_paused'))) throw new ApiError(403, 'FORBIDDEN', 'Sign-ins are paused for maintenance. Please try again a little later.');
    // Demo mode skips the code only for the seeded demo accounts; real accounts always get one.
    const instant = deps.config.demoInstantLogin && body.channel === 'email' && isDemoEmail(body.identifier) && !(await switchOn(deps.db, 'demo_login_off'));
    if (instant && !user) throw new ApiError(404, 'NOT_FOUND', 'That demo account does not exist on this server. Tap one of the listed demo accounts.');
    if (instant && !rightInstitution) throw new ApiError(404, 'NOT_FOUND', `That demo account belongs to ${user!.tenant_name}. Enter its code (Change institution).`);

    // Throttle per identifier (in addition to the per-IP limiter).
    const recent = await deps.db.query<{ n: number; last: Date | null }>(
      `select count(*) as n, max(created_at) as last from otp_challenges where identifier = $1 and created_at > $2`,
      [body.identifier, new Date(now - 3_600_000)],
    );
    const r = recent.rows[0]!;
    if (!instant && (await failuresToday(deps.db, body.identifier, now)) >= OTP_MAX_FAILURES_PER_DAY) throw lockedOut();
    if (!instant && r.n >= OTP_MAX_PER_HOUR) throw new ApiError(429, 'RATE_LIMITED', 'Too many codes requested. Try again in an hour.');
    if (!instant && r.last && now - r.last.getTime() < OTP_RESEND_AFTER_MS)
      throw new ApiError(429, 'RATE_LIMITED', 'Please wait a few seconds before requesting another code.', {
        retryAfterSec: Math.ceil((OTP_RESEND_AFTER_MS - (now - r.last.getTime())) / 1000),
      });

    // Unknown or suspended users get an indistinguishable response, but no code is ever sent.
    // Nor do accounts of an institution not yet verified by Attendly (developers aside), or of
    // another institution than the code entered in the Institute app.
    const eligible = user && user.status === 'active' && user.tenant_status === 'active' && (user.verified || user.role === 'developer') && rightInstitution;
    // People with an authenticator app type its code: nothing is sent.
    const method = eligible && user.totp && !instant ? ('authenticator' as const) : ('email' as const);
    const code = generateOtpCode();
    const expiresAt = new Date(now + OTP_TTL_MS);
    const { rows } = await deps.db.query<{ id: string }>(
      `insert into otp_challenges(user_id, channel, identifier, code_hash, expires_at, request_ip, created_at, method)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [eligible ? user!.id : null, body.channel, body.identifier, deps.hash('otp', `${body.identifier}:${code}`), expiresAt, req.ip, new Date(now), method],
    );
    const challengeId = rows[0]!.id;
    if (eligible && !instant && method === 'email') {
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
      method,
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
      const { rows } = await tx.query<{ id: string; user_id: string | null; identifier: string; code_hash: Buffer; attempts: number; expires_at: Date; consumed_at: Date | null; method: string }>(
        `select id, user_id, identifier, code_hash, attempts, expires_at, consumed_at, method from otp_challenges where id = $1 for update`,
        [body.challengeId],
      );
      const c = rows[0];
      if (!c) return { error: new ApiError(400, 'OTP_EXPIRED') };
      if (c.consumed_at || c.expires_at.getTime() <= deps.clock()) return { error: new ApiError(400, 'OTP_EXPIRED') };
      if (c.attempts >= OTP_MAX_ATTEMPTS) return { error: new ApiError(429, 'OTP_LOCKED') };
      // Serialise guesses per account so parallel codes can't exceed the daily budget.
      await tx.query(`select pg_advisory_xact_lock(hashtext('otp-guess:' || $1))`, [c.identifier]);
      const failed = await failuresToday(tx, c.identifier, deps.clock());
      if (failed >= OTP_MAX_FAILURES_PER_DAY) return { error: lockedOut() };
      let ok = false;
      if (c.method === 'authenticator' && c.user_id) {
        const u = (await tx.query<{ totp_secret_enc: Buffer | null; totp_last_step: string | null }>('select totp_secret_enc, totp_last_step from users where id = $1 for update', [c.user_id])).rows[0];
        const step = u?.totp_secret_enc ? verifyTotp(box.open(u.totp_secret_enc), body.code, deps.clock(), u.totp_last_step === null ? null : Number(u.totp_last_step)) : null;
        if (step !== null) {
          await tx.query('update users set totp_last_step = $2 where id = $1', [c.user_id, step]);
          ok = true;
        }
      } else ok = timingSafeEqual(deps.hash('otp', `${c.identifier}:${body.code}`), c.code_hash) && c.user_id !== null;
      if (!ok) {
        await tx.query('update otp_challenges set attempts = attempts + 1 where id = $1', [c.id]);
        if (c.user_id && OTP_ALERT_AT.includes(failed + 1)) await alertWrongCodes(tx, c.user_id, failed + 1);
        if (failed + 1 >= OTP_MAX_FAILURES_PER_DAY) return { error: lockedOut() };
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
      const hw = hardwareHash(deps.hash, body.device);
      // Same physical phone with a new key (the app's data was cleared, or it was reinstalled):
      // re-bind straight away — it's still their phone.
      if (bound && !bound.public_key.equals(pk) && hw && bound.hw_hash?.equals(hw) && bound.platform === body.device.platform) {
        await revokeActiveDevice(tx, user.id, 'same phone, new key (app data cleared or reinstalled)', new Date(deps.clock()));
        await appendAudit(tx, { tenantId: user.tenant_id, actorType: 'user', actorId: user.id, action: 'device.rekey_same_phone', subject: `device:${bound.id}` });
        bound = undefined;
      }
      // Demo accounts hop between test phones: the new phone simply takes over.
      if (bound && !bound.public_key.equals(pk) && deps.config.demoInstantLogin && isDemoEmail(user.email) && !(await switchOn(tx, 'demo_login_off'))) {
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
          `update devices set os_version = $2, app_version = $3, model = $4, last_seen_at = $5, hw_hash = coalesce(hw_hash, $6) where id = $1`,
          [bound.id, body.device.osVersion, body.device.appVersion, body.device.model, new Date(deps.clock()), hw],
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
        if (await switchOn(tx, 'new_bindings_blocked')) throw new ApiError(403, 'FORBIDDEN', 'New phone registrations are paused for now. Please try again later.');
        const t = await consumeTicket(tx, deps, body.ticket, 'bind', body.proof);
        const user = await loadUser(tx, t.user_id);
        if (!user || user.status !== 'active' || user.tenant_status !== 'active') throw new ApiError(403, 'ACCOUNT_SUSPENDED');
        if (await loadActiveDevice(tx, user.id)) throw new ApiError(409, 'CONFLICT', 'Another device was bound to this account in the meantime.');
        if (deps.config.demoInstantLogin && isDemoEmail(user.email)) {
          // Demo: this phone may have been used for another demo account; free it.
          // (Never between two students: one phone, one student holds in the demo too.)
          const other = await tx.query<{ user_id: string; email: string | null; role: string }>(
            `select d.user_id, u.email, u.role from devices d join users u on u.id = d.user_id where d.public_key = $1 and d.status = 'active'`,
            [t.public_key],
          );
          const o = other.rows[0];
          if (o && isDemoEmail(o.email) && !(o.role === 'student' && user.role === 'student'))
            await revokeActiveDevice(tx, o.user_id, 'demo: phone used for another demo account', new Date(deps.clock()));
        }
        const info = t.device_info;
        const hw = hardwareHash(deps.hash, info);
        await assertPhoneFree(tx, hw, user.id, user.role);
        const chip = await attestForTicket(tx, deps, user, info.platform, body.ticket, body.attestation?.chain);
        const { rows } = await tx.query<DeviceRow>(
          `insert into devices(user_id, public_key, fingerprint, platform, model, os_version, app_version, status, bound_at, last_seen_at, hw_hash,
                               hw_key_spki, attest_level, attest_patch, attested_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $8, $9, $10, $11, $12, $13) returning *`,
          [
            user.id,
            t.public_key,
            keyFingerprint(t.public_key),
            info.platform,
            info.model,
            info.osVersion,
            info.appVersion,
            new Date(deps.clock()),
            hw,
            chip?.spki ?? null,
            chip?.level ?? null,
            chip?.patch ?? null,
            chip ? new Date(deps.clock()) : null,
          ],
        );
        const device = rows[0]!;
        const auth = await issueTokens(tx, deps, { userId: user.id, deviceId: device.id });
        await appendAudit(tx, {
          tenantId: user.tenant_id,
          actorType: 'user',
          actorId: user.id,
          action: 'device.bind',
          subject: `device:${device.id}`,
          data: { fingerprint: device.fingerprint, platform: device.platform, model: device.model, hardware: chip?.level ?? 'none' },
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
      // The new phone proves its security chip now; the admin approves an already-verified phone.
      const chip = await attestForTicket(tx, deps, user, t.device_info.platform, body.ticket, body.attestation?.chain);
      const existing = await tx.query<{ id: string; kind: string; to_public_key: Buffer | null }>(
        `select id, kind, to_public_key from device_requests where user_id = $1 and status = 'pending' for update`,
        [user.id],
      );
      const prev = existing.rows[0];
      if (prev && prev.kind === 'rebind' && prev.to_public_key?.equals(t.public_key)) return { requestId: prev.id, status: 'pending' as const };
      if (prev) await tx.query(`update device_requests set status = 'cancelled', decided_at = $2 where id = $1`, [prev.id, new Date(deps.clock())]);
      const { rows } = await tx.query<{ id: string }>(
        `insert into device_requests(user_id, kind, from_device_id, to_public_key, to_device_info, reason, to_hw_key_spki, to_attest_level, to_attest_patch)
         values ($1, 'rebind', $2, $3, $4, $5, $6, $7, $8) returning id`,
        [user.id, bound?.id ?? null, t.public_key, JSON.stringify(t.device_info), body.reason, chip?.spki ?? null, chip?.level ?? null, chip?.patch ?? null],
      );
      await appendAudit(tx, {
        tenantId: user.tenant_id,
        actorType: 'user',
        actorId: user.id,
        action: 'device.rebind_request',
        subject: `request:${rows[0]!.id}`,
        data: { to: keyFingerprint(t.public_key), from: bound?.fingerprint ?? null },
      });
      await notifyDeviceRequest(tx, user.tenant_id, { id: user.id, name: user.full_name, rollNo: user.roll_no }, 'rebind', rows[0]!.id);
      return { requestId: rows[0]!.id, status: 'pending' as const };
    });
  });

  // Refreshes are signed by the device key, so a larger per-IP budget is safe (a whole
  // class's tokens can expire in the same minute behind one campus NAT).
  app.post('/v1/auth/refresh', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const body = RefreshBody.parse(req.body);
    return rotateRefreshToken(req, deps, body.refreshToken);
  });

  // ── Phones bound before hardware keys: move the key into the security chip ──
  /** Once per app start: is this phone's key in its security chip? If not (Android), a fresh challenge. */
  app.get('/v1/devices/attest', async (req): Promise<AttestStatusResponse> => {
    const auth = await requireDevice(req, deps);
    const d = (await deps.db.query<{ attest_level: 'tee' | 'strongbox' | null; hw: boolean }>('select attest_level, hw_key_spki is not null as hw from devices where id = $1', [auth.deviceId]))
      .rows[0]!;
    const required = await hardwareRequired(deps.db, deps, auth.tenantId, auth.devicePlatform);
    if (d.hw && d.attest_level) return { hardware: d.attest_level, required, challenge: null };
    if (auth.devicePlatform !== 'android' || auth.attestFailure) return { hardware: 'none', required, challenge: null };
    const challenge = randomBytes(32);
    await deps.db.query(
      `insert into attest_challenges(device_id, challenge, expires_at) values ($1, $2, $3)
       on conflict (device_id) do update set challenge = excluded.challenge, expires_at = excluded.expires_at`,
      [auth.deviceId, challenge, new Date(deps.clock() + 10 * 60_000)],
    );
    return { hardware: 'none', required, challenge: toB64url(challenge) };
  });

  /**
   * Stores the attested security-chip key for this phone. Only ever once: a phone that already has one
   * can't swap it (that needs a new binding), so a copied software key can't move the binding elsewhere.
   */
  app.post('/v1/devices/attest', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireDevice(req, deps);
    const body = AttestBody.parse(req.body);
    const failures: { code: string; detail: string }[] = [];
    try {
      return await withTx(deps.db, async (tx) => {
        const c = (await tx.query<{ challenge: Buffer; expires_at: Date }>('delete from attest_challenges where device_id = $1 returning challenge, expires_at', [auth.deviceId])).rows[0];
        if (!c || c.expires_at.getTime() <= deps.clock()) throw new ApiError(400, 'BAD_REQUEST', 'The security check expired. It will run again next time the app opens.');
        const d = (await tx.query<{ hw: boolean }>('select hw_key_spki is not null as hw from devices where id = $1 for update', [auth.deviceId])).rows[0]!;
        if (d.hw) throw new ApiError(409, 'CONFLICT', 'This phone’s key is already in its security chip.');
        const chip = checkAttestation(deps, body.chain, c.challenge, true, false, (code, detail) => failures.push({ code, detail }))!;
        await tx.query('update devices set hw_key_spki = $2, attest_level = $3, attest_patch = $4, attested_at = $5 where id = $1', [
          auth.deviceId,
          chip.spki,
          chip.level,
          chip.patch,
          new Date(deps.clock()),
        ]);
        await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'device.attested', subject: `device:${auth.deviceId}`, data: { level: chip.level } });
        return { hardware: chip.level };
      });
    } catch (err) {
      const f = failures[0];
      if (f) {
        // Google proved this phone tampered with: remember it (its scans are refused) unless checks are relaxed.
        if (isTamperEvidence(f.code) && !(await switchOn(deps.db, 'hardware_checks_relaxed')))
          await deps.db.query('update devices set attest_failure = $2 where id = $1', [auth.deviceId, f.code]);
        await withTx(deps.db, (tx) =>
          appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'device.attest_failed', subject: `device:${auth.deviceId}`, data: f }),
        );
      }
      throw err;
    }
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

