/**
 * Sign-in with an authenticator app (Google Authenticator & co.) instead of emailed codes.
 *
 *  • Anyone signed in can set it up for themselves (confirmed with a first code).
 *  • An admin can issue one to a student or teacher in person: the person scans the QR on the
 *    admin's screen and can sign in with it straight away. This is how people get codes when the
 *    institution has no email delivery.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthenticatorCodeBody, type AuthenticatorSetup, type AuthenticatorStatus } from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx } from '../db';
import { STAFF, requireAdmin } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { requireDevice } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { base32Encode, makeSecretBox, newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';

const ISSUER = 'Attendly';
const PENDING_TTL_MS = 15 * 60_000;
const write = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

export async function authenticatorRoutes(app: FastifyInstance, deps: Deps) {
  const box = makeSecretBox(deps.config.tokenPepper);
  const accountOf = (u: { email: string | null; phone: string | null; full_name: string }) => u.email ?? u.phone ?? u.full_name;

  app.get('/v1/me/authenticator', async (req): Promise<AuthenticatorStatus> => {
    const auth = await requireDevice(req, deps);
    const { rows } = await deps.db.query<{ totp_enabled_at: Date | null }>('select totp_enabled_at from users where id = $1', [auth.userId]);
    return { enabled: !!rows[0]?.totp_enabled_at, enabledAt: rows[0]?.totp_enabled_at?.toISOString() ?? null };
  });

  /** Step 1: a fresh secret, kept pending until a first code proves the app has it. */
  app.post('/v1/me/authenticator/setup', write, async (req): Promise<AuthenticatorSetup> => {
    const auth = await requireDevice(req, deps);
    const u = (await deps.db.query<{ email: string | null; phone: string | null; full_name: string }>('select email, phone, full_name from users where id = $1', [auth.userId])).rows[0]!;
    const secret = newTotpSecret();
    await deps.db.query('update users set totp_pending_enc = $2, totp_pending_expires_at = $3 where id = $1', [auth.userId, box.seal(secret), new Date(deps.clock() + PENDING_TTL_MS)]);
    return { secret: base32Encode(secret), otpauthUrl: otpauthUrl(secret, accountOf(u), ISSUER), issuer: ISSUER, account: accountOf(u), active: false };
  });

  /** Step 2: the first code from the app switches sign-in over to it. */
  app.post('/v1/me/authenticator/confirm', write, async (req): Promise<AuthenticatorStatus> => {
    const auth = await requireDevice(req, deps);
    const { code } = AuthenticatorCodeBody.parse(req.body);
    return withTx(deps.db, async (tx) => {
      const u = (await tx.query<{ totp_pending_enc: Buffer | null; totp_pending_expires_at: Date | null }>('select totp_pending_enc, totp_pending_expires_at from users where id = $1 for update', [auth.userId])).rows[0]!;
      if (!u.totp_pending_enc || !u.totp_pending_expires_at || u.totp_pending_expires_at.getTime() < deps.clock())
        throw new ApiError(409, 'CONFLICT', 'The setup expired. Start again.');
      const step = verifyTotp(box.open(u.totp_pending_enc), code, deps.clock(), null);
      if (step === null) throw new ApiError(400, 'OTP_INVALID', 'That code doesn’t match. Check the phone’s time is automatic, and use the newest code.');
      const now = new Date(deps.clock());
      await tx.query(
        `update users set totp_secret_enc = totp_pending_enc, totp_enabled_at = $2, totp_last_step = $3, totp_pending_enc = null, totp_pending_expires_at = null where id = $1`,
        [auth.userId, now, step],
      );
      await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'auth.authenticator_enable', subject: `user:${auth.userId}` });
      return { enabled: true, enabledAt: now.toISOString() };
    });
  });

  /** Turning it off needs a current code (a stolen, unlocked phone alone can't do it silently). */
  app.post('/v1/me/authenticator/disable', write, async (req): Promise<AuthenticatorStatus> => {
    const auth = await requireDevice(req, deps);
    const { code } = AuthenticatorCodeBody.parse(req.body);
    return withTx(deps.db, async (tx) => {
      const u = (await tx.query<{ totp_secret_enc: Buffer | null; totp_last_step: string | null }>('select totp_secret_enc, totp_last_step from users where id = $1 for update', [auth.userId])).rows[0]!;
      if (!u.totp_secret_enc) return { enabled: false, enabledAt: null };
      if (verifyTotp(box.open(u.totp_secret_enc), code, deps.clock(), u.totp_last_step === null ? null : Number(u.totp_last_step)) === null)
        throw new ApiError(400, 'OTP_INVALID', 'That code doesn’t match.');
      await tx.query('update users set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null where id = $1', [auth.userId]);
      await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'auth.authenticator_disable', subject: `user:${auth.userId}` });
      return { enabled: false, enabledAt: null };
    });
  });

  /** Admin, in person: a new authenticator for a student or teacher, live at once. */
  app.post('/v1/staff/people/:id/authenticator', write, async (req): Promise<AuthenticatorSetup> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return withTx(deps.db, async (tx) => {
      const u = (await tx.query<{ role: string; email: string | null; phone: string | null; full_name: string }>('select role, email, phone, full_name from users where id = $1 and tenant_id = $2 for update', [id, auth.tenantId])).rows[0];
      if (!u) throw new ApiError(404, 'NOT_FOUND', 'Person not found.');
      if (u.role !== 'student' && u.role !== 'teacher' && id !== auth.userId) throw new ApiError(403, 'FORBIDDEN', 'Admins set up their own authenticator from More → Sign-in security.');
      const secret = newTotpSecret();
      await tx.query('update users set totp_secret_enc = $2, totp_enabled_at = $3, totp_last_step = null, totp_pending_enc = null, totp_pending_expires_at = null where id = $1', [id, box.seal(secret), new Date(deps.clock())]);
      await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'auth.authenticator_issue', subject: `user:${id}` });
      return { secret: base32Encode(secret), otpauthUrl: otpauthUrl(secret, accountOf(u), ISSUER), issuer: ISSUER, account: accountOf(u), active: true };
    });
  });

  /** Admin: someone lost their phone — back to emailed codes (or issue a new one). */
  app.post('/v1/staff/people/:id/authenticator/remove', write, async (req): Promise<AuthenticatorStatus> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return withTx(deps.db, async (tx) => {
      const r = await tx.query("update users set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null where id = $1 and tenant_id = $2 and role in ('student', 'teacher')", [id, auth.tenantId]);
      if (!r.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Person not found.');
      await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'auth.authenticator_remove', subject: `user:${id}` });
      return { enabled: false, enabledAt: null };
    });
  });
}
