/**
 * Who looks after a student's phone: the mentors of the student's batches. Phone switch / reset
 * requests notify them (or, for students without a mentored batch, the admins and staff with the
 * "devices" permission), and they may approve or deny them.
 */
import type { Queryable } from '../db';
import { can } from './access';
import type { AuthContext } from './auth';
import { insertNotifications } from './notify';

export async function mentorsOf(db: Queryable, studentId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select distinct b.mentor_id as id from batch_members m join batches b on b.id = m.batch_id join users u on u.id = b.mentor_id
      where m.user_id = $1 and b.active and u.status = 'active'`,
    [studentId],
  );
  return rows.map((r) => r.id);
}

/** Staff who get a student's phone requests: the mentors, else admins and "devices" holders. */
export async function deviceApprovers(db: Queryable, tenantId: string, studentId: string): Promise<string[]> {
  const mentors = await mentorsOf(db, studentId);
  if (mentors.length) return mentors;
  const { rows } = await db.query<{ id: string }>(
    `select id from users where tenant_id = $1 and status = 'active' and (role = 'admin' or (role = 'teacher' and 'devices' = any(permissions)))`,
    [tenantId],
  );
  return rows.map((r) => r.id);
}

/** Students whose phone requests this staff member may decide (null = all of the institution). */
export async function decidableStudents(db: Queryable, auth: AuthContext): Promise<string[] | null> {
  if (can(auth, 'devices')) return null;
  const { rows } = await db.query<{ id: string }>(
    `select distinct m.user_id as id from batches b join batch_members m on m.batch_id = b.id where b.mentor_id = $1 and b.tenant_id = $2`,
    [auth.userId, auth.tenantId],
  );
  return rows.map((r) => r.id);
}

export async function mentoredBatches(db: Queryable, auth: AuthContext): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query<{ id: string; name: string }>('select id, name from batches where mentor_id = $1 and tenant_id = $2 and active order by name', [auth.userId, auth.tenantId]);
  return rows;
}

export async function notifyDeviceRequest(db: Queryable, tenantId: string, student: { id: string; name: string; rollNo: string | null }, kind: 'rebind' | 'reset', requestId: string) {
  const to = await deviceApprovers(db, tenantId, student.id);
  const who = student.rollNo ? `${student.name} (${student.rollNo})` : student.name;
  await insertNotifications(
    db,
    tenantId,
    to.map((userId) => ({
      userId,
      kind: 'device_request',
      title: kind === 'rebind' ? `📱 ${who} wants to switch phones` : `📱 ${who} asks to unbind their phone`,
      body: 'Tap to approve or deny.',
      data: { requestId, studentId: student.id },
    })),
  );
}
