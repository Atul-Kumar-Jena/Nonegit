/**
 * First sign-in with a setup code (no email needed):
 *   1. start  — sign-in ID + setup code → a new Google Authenticator key (kept pending 15 minutes);
 *   2. finish — the first 6-digit code from Google Authenticator → the authenticator is linked, the
 *      setup code is used up, and a one-time sign-in code is returned so the app continues straight
 *      into the usual device binding (the same path as every other sign-in).
 * Afterwards the person signs in with their ID and the authenticator's code.
 */
import type { FastifyInstance } from 'fastify';
import { OtpRequestResponse, SetupFinishBody, SetupStartBody, type SetupStartResponse } from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { appendAudit } from '../lib/audit';
import { ApiError } from '../lib/errors';
import { switchOn } from '../lib/flags';
import { generateOtpCode, maskEmail, maskPhone } from '../lib/secrets';
import { checkSetupCode, type SetupCodeState } from '../lib/setup-codes';
import { base32Encode, makeSecretBox, newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';
import { OTP_RESEND_AFTER_MS, OTP_TTL_MS } from './auth';

const ISSUER = 'Attendly';
const PENDING_TTL_MS = 15 * 60_000;
const limit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
const NO_MATCH = 'That sign-in ID and setup code don’t match, or the code was used or has expired. Ask for a new setup code.';

interface SetupUser extends SetupCodeState {
  id: string;
  tenant_id: string;
  role: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  tenant_status: string;
  tenant_name: string;
  tenant_code: string;
  verified: boolean;
  totp_pending_enc: Buffer | null;
  totp_pending_expires_at: Date | null;
}

async function loadForSetup(db: Queryable, identifier: string): Promise<SetupUser | undefined> {
  const { rows } = await db.query<SetupUser>(
    `select u.id, u.tenant_id, u.role, u.full_name, u.email, u.phone, u.status, u.setup_code_hash, u.setup_code_expires_at, u.setup_code_attempts,
            u.totp_pending_enc, u.totp_pending_expires_at,
            t.status as tenant_status, t.name as tenant_name, t.code as tenant_code, t.verified_at is not null as verified
       from users u join tenants t on t.id = u.tenant_id
      where (u.email = $1 or u.phone = $1)
      for update of u`,
    [identifier],
  );
  return rows[0];
}

export async function setupRoutes(app: FastifyInstance, deps: Deps) {
  const box = makeSecretBox(deps.config.tokenPepper);
  const accountOf = (u: SetupUser) => u.email ?? u.phone ?? u.full_name;

  /**
   * Checks the ID + setup code inside a transaction. A wrong guess is counted (and committed) before
   * the error is thrown, so guesses can't be retried for free.
   */
  async function withSetupCode<T>(identifier: string, code: string, institutionCode: string | undefined, run: (tx: Queryable, u: SetupUser) => Promise<T>): Promise<T> {
    const now = deps.clock();
    const verdict = await withTx(deps.db, async (tx) => {
      const u = await loadForSetup(tx, identifier);
      if (!u) return { error: new ApiError(400, 'BAD_REQUEST', NO_MATCH) };
      if (u.role !== 'developer' && (await switchOn(tx, 'sign_ins_paused'))) return { error: new ApiError(403, 'FORBIDDEN', 'Sign-ins are paused for maintenance. Please try again a little later.') };
      const check = checkSetupCode(deps.hash, u.id, u, code, now);
      if (check === 'wrong') await tx.query('update users set setup_code_attempts = setup_code_attempts + 1 where id = $1', [u.id]);
      if (check !== 'ok') return { error: new ApiError(400, 'BAD_REQUEST', NO_MATCH) };
      if (institutionCode && institutionCode !== u.tenant_code) return { error: new ApiError(400, 'BAD_REQUEST', `This account belongs to another institution. Tap Change and enter its code.`) };
      if (u.status !== 'active' || u.tenant_status !== 'active') return { error: new ApiError(403, 'ACCOUNT_SUSPENDED') };
      if (!u.verified && u.role !== 'developer') return { error: new ApiError(403, 'FORBIDDEN', `${u.tenant_name} isn’t verified by Attendly yet. Ask Attendly to verify it, then try again.`) };
      return { value: await run(tx, u) };
    });
    if ('error' in verdict) throw verdict.error;
    return verdict.value;
  }

  app.post('/v1/auth/setup/start', limit, async (req): Promise<SetupStartResponse> => {
    const b = SetupStartBody.parse(req.body);
    return withSetupCode(b.identifier, b.setupCode, b.institutionCode, async (tx, u) => {
      const secret = newTotpSecret();
      const expiresAt = new Date(deps.clock() + PENDING_TTL_MS);
      await tx.query('update users set totp_pending_enc = $2, totp_pending_expires_at = $3 where id = $1', [u.id, box.seal(secret), expiresAt]);
      return {
        name: u.full_name,
        institution: u.tenant_name,
        issuer: ISSUER,
        account: accountOf(u),
        secret: base32Encode(secret),
        otpauthUrl: otpauthUrl(secret, accountOf(u), ISSUER),
        expiresAt: expiresAt.toISOString(),
      };
    });
  });

  app.post('/v1/auth/setup/finish', limit, async (req): Promise<OtpRequestResponse> => {
    const b = SetupFinishBody.parse(req.body);
    const now = deps.clock();
    return withSetupCode(b.identifier, b.setupCode, b.institutionCode, async (tx, u) => {
      if (!u.totp_pending_enc || !u.totp_pending_expires_at || u.totp_pending_expires_at.getTime() <= now)
        throw new ApiError(409, 'CONFLICT', 'This step took too long. Start again with the same setup code.');
      const step = verifyTotp(box.open(u.totp_pending_enc), b.code, now, null);
      if (step === null) throw new ApiError(400, 'OTP_INVALID', 'That code doesn’t match. Use the newest code for “Attendly” in Google Authenticator, and check the phone’s time is set automatically.');
      await tx.query(
        `update users set totp_secret_enc = totp_pending_enc, totp_enabled_at = $2, totp_last_step = $3, totp_pending_enc = null, totp_pending_expires_at = null,
                          setup_code_hash = null, setup_code_expires_at = null, setup_code_attempts = 0
          where id = $1`,
        [u.id, new Date(now), step],
      );
      await appendAudit(tx, { tenantId: u.tenant_id, actorType: 'user', actorId: u.id, action: 'auth.setup_complete', subject: `user:${u.id}` });
      // A one-time sign-in code for this app only: it carries on into device binding as usual.
      const channel = b.identifier.includes('@') ? ('email' as const) : ('phone' as const);
      const code = generateOtpCode();
      const expiresAt = new Date(now + OTP_TTL_MS);
      const { rows } = await tx.query<{ id: string }>(
        `insert into otp_challenges(user_id, channel, identifier, code_hash, expires_at, request_ip, created_at, method)
         values ($1, $2, $3, $4, $5, $6, $7, 'email') returning id`,
        [u.id, channel, b.identifier, deps.hash('otp', `${b.identifier}:${code}`), expiresAt, req.ip, new Date(now)],
      );
      return {
        challengeId: rows[0]!.id,
        expiresAt: expiresAt.toISOString(),
        resendAfterSec: OTP_RESEND_AFTER_MS / 1000,
        destination: channel === 'email' ? maskEmail(b.identifier) : maskPhone(b.identifier),
        method: 'authenticator',
        instantCode: code,
      };
    });
  });
}
