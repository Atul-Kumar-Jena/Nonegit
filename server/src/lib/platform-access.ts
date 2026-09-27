/**
 * Start-up housekeeping for who runs what:
 *  • every institution has a main admin (older data: its earliest admin);
 *  • the platform owner's developer account exists, and until Google Authenticator is linked in
 *    Attendly Developer a one-time setup code for it is printed in the server log.
 */
import type { Config } from '../config';
import { withTx, type Db } from '../db';
import { appendAudit } from './audit';
import type { Hasher } from './secrets';
import { issueSetupCode } from './setup-codes';
import { revokeActiveDevice } from '../routes/staff-admin';

/** The developer's setup code is only good for a day (and replaced at every restart). */
export const DEVELOPER_SETUP_TTL_MS = 24 * 3_600_000;

export async function ensureOwners(db: Db): Promise<void> {
  await db.query(
    `update users set is_owner = true where id in (
       select distinct on (u.tenant_id) u.id from users u
        where u.role = 'admin' and u.status = 'active'
          and not exists (select 1 from users o where o.tenant_id = u.tenant_id and o.is_owner)
        order by u.tenant_id, u.created_at, u.id)`,
  );
}

export async function ensureDeveloperAccess(db: Db, config: Config, hash: Hasher, now: number, log: (m: string) => void): Promise<void> {
  const id = config.developer.signInId;
  await withTx(db, async (tx) => {
    let dev = (await tx.query<{ id: string; role: string; totp: boolean }>('select id, role, totp_enabled_at is not null as totp from users where email = $1 for update', [id])).rows[0];
    if (dev && dev.role !== 'developer') {
      log(`${id} is a ${dev.role} account, not a developer: set DEVELOPER_SIGN_IN_ID to another address.`);
      return;
    }
    if (!dev) {
      // No institution of its own yet: the platform gets one (verified, never shown to staff).
      let platform = (await tx.query<{ id: string }>(`select id from tenants where slug = 'attendly-platform'`)).rows[0];
      if (!platform)
        platform = (
          await tx.query<{ id: string }>(
            `insert into tenants(slug, name, email_domains, timezone, term_name, term_start, verified_at)
             values ('attendly-platform', 'Attendly (platform)', $1, 'Asia/Kolkata', 'Current term', current_date, now()) returning id`,
            [[id.split('@')[1]!]],
          )
        ).rows[0]!;
      dev = (await tx.query<{ id: string; role: string; totp: boolean }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'developer', 'Platform owner', $2) returning id, role, false as totp`, [platform.id, id])).rows[0]!;
      await appendAudit(tx, { tenantId: platform.id, actorType: 'system', action: 'platform.developer_create', subject: `user:${dev.id}` });
      log(`created the developer account ${id}`);
    }
    if (config.developer.resetAuthenticator && dev.totp) {
      await tx.query('update users set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null where id = $1', [dev.id]);
      await revokeActiveDevice(tx, dev.id, 'developer authenticator reset', new Date(now));
      await appendAudit(tx, { tenantId: null, actorType: 'system', action: 'platform.developer_reset', subject: `user:${dev.id}` });
      dev.totp = false;
      log('DEVELOPER_AUTHENTICATOR_RESET: the developer authenticator and phone were cleared. Remove the setting after setting up again.');
    }
    if (dev.totp) return;
    const setup = await issueSetupCode(tx, hash, dev.id, now, DEVELOPER_SETUP_TTL_MS);
    log(`Attendly Developer first-time setup → sign-in ID ${id} · setup code ${setup.code} (valid 24 h; open Attendly Developer → “First-time setup”)`);
  });
}
