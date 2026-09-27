/**
 * Support: the developer opens an institution from Attendly Developer and manages its people —
 * suspend or reactivate an account, unlink a lost phone, issue a setup code, change a role, or hand
 * the main-admin role to someone else.
 *
 * Nothing here is hidden: every action is appended to the institution's audit chain and to the
 * platform chain under the developer's own account, with the reason given. The only choice ("as")
 * is how the institution's people see the author in their notifications — the developer's name,
 * or "Attendly support".
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SupportActionBody, type Person, type SupportActionResult, type SupportPerson } from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { appendAudit } from '../lib/audit';
import { ApiError } from '../lib/errors';
import { insertNotifications } from '../lib/notify';
import { issueSetupCode } from '../lib/setup-codes';
import { AUDIT_SELECT, noSandboxOnDemo, requireRoot, toAuditEntry, type AuditRow, type RootAuth } from './root';
import { PERSON_SELECT, loadPerson, revokeActiveDevice, toPerson, type PersonRow } from './staff-admin';

const write = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
const Params = z.object({ id: z.uuid() });
const PersonParams = z.object({ id: z.uuid(), pid: z.uuid() });

function inScope(r: RootAuth, tenantId: string) {
  if (r.tenants && !r.tenants.includes(tenantId)) throw new ApiError(404, 'NOT_FOUND', 'Institution not found.');
}

async function attendanceOf(db: Queryable, userId: string) {
  const { rows } = await db.query<{ held: number; attended: number }>(
    `select count(*)::int as held,
            count(*) filter (where exists (select 1 from attendance_records a where a.session_id = s.id and a.user_id = $1 and a.revoked_at is null))::int as attended
       from class_sessions s join enrollments e on e.course_id = s.course_id and e.user_id = $1
      where s.status = 'closed'`,
    [userId],
  );
  const r = rows[0]!;
  return { held: r.held, attended: r.attended, percent: r.held ? Math.round((r.attended / r.held) * 1000) / 10 : null };
}

export async function rootSupportRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/v1/root/tenants/:id/people', async (req): Promise<Person[]> => {
    const r = await requireRoot(req, deps);
    const { id } = Params.parse(req.params);
    inScope(r, id);
    const q = z.object({ role: z.enum(['student', 'teacher', 'admin', 'staff']).default('student'), q: z.string().trim().max(60).optional() }).parse(req.query);
    const roles = q.role === 'staff' ? ['teacher', 'admin'] : [q.role];
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const { rows } = await deps.db.query<PersonRow>(
      `${PERSON_SELECT}
        where u.tenant_id = $1 and u.role = any($2::text[])
          and ($3::text is null or u.full_name ilike $3 or u.roll_no ilike $3 or u.email ilike $3 or u.phone ilike $3)
        order by u.is_owner desc, u.status, u.roll_no nulls last, u.full_name
        limit 500`,
      [id, roles, like],
    );
    return rows.map(toPerson);
  });

  app.get('/v1/root/tenants/:id/people/:pid', async (req): Promise<SupportPerson> => {
    const r = await requireRoot(req, deps);
    const { id, pid } = PersonParams.parse(req.params);
    inScope(r, id);
    const person = await loadPerson(deps.db, id, pid);
    const history = await deps.db.query<AuditRow>(
      `${AUDIT_SELECT} where a.tenant_id = $1 and (a.subject = $2 or a.actor_id = $3) order by a.id desc limit 30`,
      [id, `user:${pid}`, pid],
    );
    return { person, attendance: person.role === 'student' ? await attendanceOf(deps.db, pid) : null, history: history.rows.map(toAuditEntry) };
  });

  app.post('/v1/root/tenants/:id/people/:pid/action', write, async (req): Promise<SupportActionResult> => {
    const r = await requireRoot(req, deps);
    const { id, pid } = PersonParams.parse(req.params);
    inScope(r, id);
    // The shared demo institute stays as it is for everyone trying it.
    noSandboxOnDemo(r, id, 'changing people');
    const b = SupportActionBody.parse(req.body);
    const now = new Date(deps.clock());
    const author = b.as === 'named' ? r.name : 'Attendly support';
    const result = await withTx(deps.db, async (tx) => {
      const u = (
        await tx.query<{ role: string; status: string; is_owner: boolean; full_name: string; email: string | null; phone: string | null }>(
          'select role, status, is_owner, full_name, email, phone from users where id = $1 and tenant_id = $2 for update',
          [pid, id],
        )
      ).rows[0];
      if (!u || u.role === 'developer') throw new ApiError(404, 'NOT_FOUND', 'Person not found.');
      let setup: SupportActionResult['setup'] = null;
      let message = '';
      let notify: { title: string; body: string } | null = null;
      switch (b.action) {
        case 'suspend':
          if (u.is_owner) throw new ApiError(409, 'CONFLICT', 'Hand the main-admin role to someone else before suspending this account.');
          await tx.query(`update users set status = 'suspended' where id = $1`, [pid]);
          await tx.query(`update auth_sessions set revoked_at = $2, revoke_reason = 'suspended by Attendly' where user_id = $1 and revoked_at is null`, [pid, now]);
          message = `${u.full_name} is suspended and signed out.`;
          break;
        case 'reactivate':
          await tx.query(`update users set status = 'active' where id = $1`, [pid]);
          message = `${u.full_name} can sign in again.`;
          notify = { title: 'Your account is active again', body: `${author} reactivated your Attendly account.` };
          break;
        case 'reset_phone': {
          const was = await revokeActiveDevice(tx, pid, `reset by Attendly: ${b.reason}`, now);
          if (!was) throw new ApiError(409, 'CONFLICT', 'No phone is linked to this account.');
          message = `${u.full_name}’s phone is unlinked; they bind their phone again at the next sign-in.`;
          notify = { title: 'Your phone was unlinked', body: `${author} unlinked your phone: ${b.reason}. Sign in again to bind your phone.` };
          break;
        }
        case 'setup_code': {
          const code = await issueSetupCode(tx, deps.hash, pid, deps.clock());
          setup = { name: u.full_name, signInId: u.email ?? u.phone ?? '', code: code.code, expiresAt: code.expiresAt.toISOString() };
          message = `New setup code for ${u.full_name} (works once).`;
          break;
        }
        case 'make_admin':
        case 'make_professor': {
          if (u.role === 'student') throw new ApiError(400, 'BAD_REQUEST', 'Students don’t have staff roles.');
          if (b.action === 'make_professor' && u.is_owner) throw new ApiError(409, 'CONFLICT', 'The main admin stays an admin. Hand the main-admin role to someone else first.');
          const role = b.action === 'make_admin' ? 'admin' : 'teacher';
          await tx.query(`update users set role = $2, permissions = case when $2 = 'admin' then '{}' else permissions end where id = $1`, [pid, role]);
          message = `${u.full_name} is now ${role === 'admin' ? 'an admin' : 'a professor'}.`;
          notify = { title: role === 'admin' ? 'You are now an admin' : 'You are now a professor', body: `Changed by ${author}.` };
          break;
        }
        case 'make_owner': {
          if (u.role !== 'admin') throw new ApiError(400, 'BAD_REQUEST', 'Make them an admin first.');
          if (u.is_owner) throw new ApiError(409, 'CONFLICT', 'Already the main admin.');
          await tx.query(`update users set is_owner = false where tenant_id = $1 and is_owner`, [id]);
          await tx.query(`update users set is_owner = true where id = $1`, [pid]);
          message = `${u.full_name} is now the main admin.`;
          notify = { title: 'You are now the main admin', body: `${author} made you your institution’s main admin: you add, change and remove admins.` };
          break;
        }
      }
      // Always on the record, under the developer's own account, whatever the institution is shown.
      await appendAudit(tx, { tenantId: id, actorType: 'user', actorId: r.userId, action: `support.${b.action}`, subject: `user:${pid}`, data: { reason: b.reason, shownAs: b.as } });
      await appendAudit(tx, { tenantId: null, actorType: 'user', actorId: r.userId, action: 'root.support', subject: `user:${pid}`, data: { tenantId: id, action: b.action, reason: b.reason, shownAs: b.as } });
      if (notify) await insertNotifications(tx, id, [{ userId: pid, kind: b.action === 'reset_phone' ? 'device' : 'access', title: notify.title, body: notify.body, data: {} }]);
      return { setup, message };
    });
    return { person: await loadPerson(deps.db, id, pid), ...result };
  });
}
