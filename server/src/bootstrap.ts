import { randomBytes } from '@attendly/protocol';
import type { Config } from './config';
import { withTx, type Db } from './db';
import { appendAudit } from './lib/audit';

/**
 * Production first-run: creates the institution and its first admin from
 * BOOTSTRAP_* settings (and optionally one demo teacher and one demo student). Idempotent — once the
 * admin exists nothing is changed, so it is safe to leave configured.
 * Everything else (teachers, students, rooms, courses, timetable) is created
 * from the Institute app.
 */
export async function bootstrapInstitution(db: Db, config: Config, log: (m: string) => void = console.log): Promise<void> {
  const b = config.bootstrap;
  if (!b) return;
  await withTx(db, async (tx) => {
    const existing = await tx.query<{ tenant_id: string }>('select tenant_id from users where email = $1', [b.adminEmail]);
    let tenantId = existing.rows[0]?.tenant_id;
    if (!tenantId) {
      const tz = await tx.query('select 1 from pg_timezone_names where name = $1', [b.timezone]);
      if (tz.rowCount !== 1) throw new Error(`BOOTSTRAP_TIMEZONE "${b.timezone}" is not a valid timezone`);
      const base = b.institutionName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'institution';
      const taken = await tx.query('select 1 from tenants where slug = $1', [base]);
      const slug = taken.rowCount ? `${base}-${Array.from(randomBytes(2), (x) => x.toString(16).padStart(2, '0')).join('')}` : base;
      const t = await tx.query<{ id: string }>(
        `insert into tenants(slug, name, email_domains, timezone, term_name, term_start)
         values ($1, $2, $3, $4, 'Current term', (now() at time zone $4)::date) returning id`,
        [slug, b.institutionName, [b.adminEmail.split('@')[1]!], b.timezone],
      );
      tenantId = t.rows[0]!.id;
      const admin = await tx.query<{ id: string }>(`insert into users(tenant_id, role, full_name, email) values ($1, 'admin', $2, $3) returning id`, [
        tenantId,
        b.adminName,
        b.adminEmail,
      ]);
      await appendAudit(tx, { tenantId, actorType: 'system', action: 'institution.bootstrap', subject: `user:${admin.rows[0]!.id}`, data: { slug } });
      log(`created institution "${b.institutionName}" with admin ${b.adminEmail}`);
    }
    if (b.demoTeacherEmail) {
      const t = await tx.query('select 1 from users where email = $1', [b.demoTeacherEmail]);
      if (!t.rowCount) {
        await tx.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'teacher', 'Demo Teacher', $2)`, [tenantId, b.demoTeacherEmail]);
        log(`created demo teacher ${b.demoTeacherEmail}`);
      }
    }
    if (b.developerEmail) {
      const d = await tx.query('select 1 from users where email = $1', [b.developerEmail]);
      if (!d.rowCount) {
        await tx.query(`insert into users(tenant_id, role, full_name, email) values ($1, 'developer', 'Platform owner', $2)`, [tenantId, b.developerEmail]);
        await appendAudit(tx, { tenantId, actorType: 'system', action: 'institution.bootstrap_developer', subject: `email:${b.developerEmail}` });
        log(`created developer account ${b.developerEmail}`);
      }
    }
    if (b.demoStudentEmail) {
      const s = await tx.query('select 1 from users where email = $1', [b.demoStudentEmail]);
      if (!s.rowCount) {
        await tx.query(`insert into users(tenant_id, role, full_name, email, roll_no) values ($1, 'student', 'Demo Student', $2, 'DEMO-001')`, [
          tenantId,
          b.demoStudentEmail,
        ]);
        log(`created demo student ${b.demoStudentEmail}`);
      }
    }
  });
}
