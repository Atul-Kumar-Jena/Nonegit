/**
 * Institute app — institution, rooms and people. Admin-only writes; teachers read what they need.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BulkImportBody,
  PersonBody,
  PersonUpdateBody,
  RoomBody,
  UpdateInstitutionBody,
  type BulkImportResponse,
  type InstitutionSettings,
  type Overview,
  type Person,
  type Room,
  type StaffMe,
} from '@attendly/protocol';
import type { PoolClient } from 'pg';
import type { Deps } from '../deps';
import { isUniqueViolation, withTx, type Queryable } from '../db';
import { STAFF, instructorFilter, isAdmin, requireAdmin } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { requireDevice, type AuthContext } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { listStaffSessions, localDayBounds } from '../lib/staff-sessions';
import { loadDevice, loadUser, toDeviceSummary, toUserSummary } from '../lib/users';

const IdParam = z.object({ id: z.uuid() });

async function institution(db: Queryable, tenantId: string): Promise<InstitutionSettings> {
  const { rows } = await db.query<{
    name: string;
    slug: string;
    timezone: string;
    min_attendance: number;
    term_name: string;
    term_start: string;
    email_domains: string[];
    device_reset_limit: number;
  }>(
    `select name, slug, timezone, min_attendance, term_name, to_char(term_start, 'YYYY-MM-DD') as term_start, email_domains, device_reset_limit
       from tenants where id = $1`,
    [tenantId],
  );
  const t = rows[0]!;
  return {
    name: t.name,
    slug: t.slug,
    timezone: t.timezone,
    minAttendance: t.min_attendance,
    termName: t.term_name,
    termStart: t.term_start,
    emailDomains: t.email_domains,
    deviceResetLimit: t.device_reset_limit,
  };
}

interface PersonRow {
  id: string;
  role: Person['role'];
  full_name: string;
  email: string | null;
  phone: string | null;
  roll_no: string | null;
  department: string | null;
  semester: number | null;
  status: 'active' | 'suspended';
  device_model: string | null;
  device_fingerprint: string | null;
  device_bound_at: Date | null;
  course_ids: string[] | null;
}

const PERSON_SELECT = `
  select u.id, u.role, u.full_name, u.email, u.phone, u.roll_no, u.department, u.semester, u.status,
         d.model as device_model, d.fingerprint as device_fingerprint, d.bound_at as device_bound_at,
         (select array_agg(e.course_id) from enrollments e where e.user_id = u.id) as course_ids
    from users u left join devices d on d.user_id = u.id and d.status = 'active'`;

function toPerson(r: PersonRow): Person {
  return {
    id: r.id,
    role: r.role,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    rollNo: r.roll_no,
    department: r.department,
    semester: r.semester,
    status: r.status,
    device: r.device_model && r.device_fingerprint ? { model: r.device_model, fingerprint: r.device_fingerprint, boundAt: r.device_bound_at?.toISOString() ?? null } : null,
    courseIds: r.course_ids ?? [],
  };
}

async function loadPerson(db: Queryable, tenantId: string, id: string): Promise<Person> {
  const { rows } = await db.query<PersonRow>(`${PERSON_SELECT} where u.id = $1 and u.tenant_id = $2`, [id, tenantId]);
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Person not found.');
  return toPerson(rows[0]);
}

/** Replace a student's enrollments with exactly `courseIds` (all must belong to the tenant). */
async function setEnrollments(tx: PoolClient, tenantId: string, userId: string, courseIds: string[]) {
  const unique = [...new Set(courseIds)];
  if (unique.length) {
    const ok = await tx.query('select id from courses where tenant_id = $1 and id = any($2::uuid[])', [tenantId, unique]);
    if (ok.rowCount !== unique.length) throw new ApiError(400, 'BAD_REQUEST', 'One or more courses do not exist.');
  }
  await tx.query('delete from enrollments where user_id = $1 and not (course_id = any($2::uuid[]))', [userId, unique]);
  for (const c of unique) await tx.query('insert into enrollments(course_id, user_id) values ($1, $2) on conflict do nothing', [c, userId]);
}

/** Revoke a person's bound phone and every login on it. */
export async function revokeActiveDevice(tx: Queryable, userId: string, reason: string, now: Date): Promise<string | null> {
  const d = await tx.query<{ id: string; fingerprint: string }>(
    `update devices set status = 'revoked', revoked_at = $2, revoke_reason = $3 where user_id = $1 and status = 'active' returning id, fingerprint`,
    [userId, now, reason],
  );
  const dev = d.rows[0];
  if (dev) await tx.query(`update auth_sessions set revoked_at = $2, revoke_reason = $3 where device_id = $1 and revoked_at is null`, [dev.id, now, reason]);
  return dev?.fingerprint ?? null;
}

function conflictMessage(err: unknown): string | null {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== '23505') return null;
  if (e.constraint === 'users_email_key') return 'That email is already used by another account.';
  if (e.constraint === 'users_phone_key') return 'That phone number is already used by another account.';
  if (e.constraint === 'users_tenant_id_roll_no_key') return 'That roll number is already used in this institution.';
  if (e.constraint === 'rooms_tenant_id_name_key') return 'A room with that name already exists.';
  return 'That conflicts with an existing record.';
}

async function audit(tx: Queryable, auth: AuthContext, action: string, subject: string, data: Record<string, unknown> = {}) {
  await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action, subject, data });
}

export async function staffAdminRoutes(app: FastifyInstance, deps: Deps) {
  const now = () => new Date(deps.clock());

  app.get('/v1/staff/me', async (req): Promise<StaffMe> => {
    const auth = await requireDevice(req, deps, STAFF);
    const [user, device] = await Promise.all([loadUser(deps.db, auth.userId), loadDevice(deps.db, auth.deviceId)]);
    return { user: toUserSummary(user!), device: toDeviceSummary(device!), institution: await institution(deps.db, auth.tenantId) };
  });

  app.get('/v1/staff/overview', async (req): Promise<Overview> => {
    const auth = await requireDevice(req, deps, STAFF);
    const inst = await institution(deps.db, auth.tenantId);
    const day = await localDayBounds(deps.db, inst.timezone, null);
    const scope = instructorFilter(auth);
    const today = await listStaffSessions(deps.db, { tenantId: auth.tenantId, instructorId: scope, from: day.from, to: day.to, includeLive: true });
    const counts = await deps.db.query<{ marked: number; flagged: number; requests: number }>(
      `select
         (select count(*) from attendance_records a join class_sessions s on s.id = a.session_id join courses c on c.id = s.course_id
           where s.tenant_id = $1 and ($2::uuid is null or c.instructor_id = $2) and a.revoked_at is null and a.marked_at >= $3 and a.marked_at < $4) as marked,
         (select count(*) from scan_rejections x join class_sessions s on s.id = x.session_id join courses c on c.id = s.course_id
           where x.tenant_id = $1 and ($2::uuid is null or c.instructor_id = $2) and x.suspicious and x.review_status = 'open') as flagged,
         (select count(*) from device_requests r join users u on u.id = r.user_id where u.tenant_id = $1 and r.status = 'pending') as requests`,
      [auth.tenantId, scope, day.from, day.to],
    );
    const c = counts.rows[0]!;
    return {
      role: isAdmin(auth) ? 'admin' : 'teacher',
      liveNow: today.filter((s) => s.status === 'live').length,
      markedToday: c.marked,
      flaggedOpen: c.flagged,
      pendingRequests: isAdmin(auth) ? c.requests : 0,
      today,
      timezone: inst.timezone,
      serverTime: deps.clock(),
    };
  });

  // ── institution settings ──
  app.get('/v1/staff/institution', async (req): Promise<InstitutionSettings> => {
    const auth = await requireDevice(req, deps, STAFF);
    return institution(deps.db, auth.tenantId);
  });

  app.post('/v1/staff/institution', async (req): Promise<InstitutionSettings> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const b = UpdateInstitutionBody.parse(req.body);
    if (b.timezone) {
      const tz = await deps.db.query('select 1 from pg_timezone_names where name = $1', [b.timezone]);
      if (tz.rowCount !== 1) throw new ApiError(400, 'BAD_REQUEST', 'Unknown timezone. Use a name like Asia/Kolkata.');
    }
    await withTx(deps.db, async (tx) => {
      await tx.query(
        `update tenants set name = coalesce($2, name), timezone = coalesce($3, timezone), min_attendance = coalesce($4, min_attendance),
                term_name = coalesce($5, term_name), term_start = coalesce($6::date, term_start), email_domains = coalesce($7, email_domains),
                device_reset_limit = coalesce($8, device_reset_limit)
          where id = $1`,
        [auth.tenantId, b.name ?? null, b.timezone ?? null, b.minAttendance ?? null, b.termName ?? null, b.termStart ?? null, b.emailDomains ?? null, b.deviceResetLimit ?? null],
      );
      await audit(tx, auth, 'institution.update', `tenant:${auth.tenantId}`, b as Record<string, unknown>);
    });
    return institution(deps.db, auth.tenantId);
  });

  // ── rooms ──
  const toRoom = (r: { id: string; name: string; lat: number | null; lng: number | null; radius_m: number; active: boolean }): Room => ({
    id: r.id,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    radiusM: r.radius_m,
    active: r.active,
  });

  app.get('/v1/staff/rooms', async (req): Promise<Room[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { rows } = await deps.db.query('select * from rooms where tenant_id = $1 order by active desc, name', [auth.tenantId]);
    return rows.map(toRoom);
  });

  async function saveRoom(auth: AuthContext, id: string | null, body: unknown): Promise<Room> {
    requireAdmin(auth);
    const b = RoomBody.parse(body);
    try {
      return await withTx(deps.db, async (tx) => {
        const { rows } = id
          ? await tx.query(
              `update rooms set name = $3, lat = $4, lng = $5, radius_m = $6, active = $7 where id = $1 and tenant_id = $2 returning *`,
              [id, auth.tenantId, b.name, b.lat ?? null, b.lng ?? null, b.radiusM, b.active],
            )
          : await tx.query(`insert into rooms(tenant_id, name, lat, lng, radius_m, active) values ($1, $2, $3, $4, $5, $6) returning *`, [
              auth.tenantId,
              b.name,
              b.lat ?? null,
              b.lng ?? null,
              b.radiusM,
              b.active,
            ]);
        if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Room not found.');
        // Upcoming classes in this room pick up the new geofence (live ones keep theirs).
        await tx.query(
          `update class_sessions set lat = $2, lng = $3, radius_m = $4, room = $5 where room_id = $1 and status = 'scheduled'`,
          [rows[0].id, b.lat ?? null, b.lng ?? null, b.radiusM, b.name],
        );
        await audit(tx, auth, id ? 'room.update' : 'room.create', `room:${rows[0].id}`, { name: b.name, located: b.lat != null, radiusM: b.radiusM });
        return toRoom(rows[0]);
      });
    } catch (err) {
      const msg = conflictMessage(err);
      if (msg) throw new ApiError(409, 'CONFLICT', msg);
      throw err;
    }
  }

  app.post('/v1/staff/rooms', async (req) => saveRoom(await requireDevice(req, deps, STAFF), null, req.body));
  app.post('/v1/staff/rooms/:id', async (req) => saveRoom(await requireDevice(req, deps, STAFF), IdParam.parse(req.params).id, req.body));

  // ── people ──
  app.get('/v1/staff/people', async (req): Promise<Person[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const q = z
      .object({ role: z.enum(['student', 'teacher', 'admin', 'staff']).default('student'), q: z.string().trim().max(60).optional(), courseId: z.uuid().optional() })
      .parse(req.query);
    if (q.role !== 'student') requireAdmin(auth);
    const roles = q.role === 'staff' ? ['teacher', 'admin'] : [q.role];
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const { rows } = await deps.db.query<PersonRow>(
      `${PERSON_SELECT}
        where u.tenant_id = $1 and u.role = any($2::text[])
          and ($3::text is null or u.full_name ilike $3 or u.roll_no ilike $3 or u.email ilike $3 or u.phone ilike $3)
          and ($4::uuid is null or exists (select 1 from enrollments e where e.user_id = u.id and e.course_id = $4))
          and ($5::uuid is null or exists (select 1 from enrollments e join courses c on c.id = e.course_id where e.user_id = u.id and c.instructor_id = $5))
        order by u.status, u.roll_no nulls last, u.full_name
        limit 1000`,
      [auth.tenantId, roles, like, q.courseId ?? null, instructorFilter(auth)],
    );
    return rows.map(toPerson);
  });

  app.get('/v1/staff/people/:id', async (req): Promise<Person> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const p = await loadPerson(deps.db, auth.tenantId, id);
    if (!isAdmin(auth)) {
      const visible = await deps.db.query(
        'select 1 from enrollments e join courses c on c.id = e.course_id where e.user_id = $1 and c.instructor_id = $2 limit 1',
        [id, auth.userId],
      );
      if (p.role !== 'student' || visible.rowCount !== 1) throw new ApiError(404, 'NOT_FOUND', 'Person not found.');
    }
    return p;
  });

  async function createPerson(tx: PoolClient, auth: AuthContext, b: PersonBody): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `insert into users(tenant_id, role, full_name, email, phone, roll_no, department, semester, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [auth.tenantId, b.role, b.fullName, b.email ?? null, b.phone ?? null, b.rollNo ?? null, b.department ?? null, b.semester ?? null, auth.userId],
    );
    const id = rows[0]!.id;
    if (b.role === 'student' && b.courseIds?.length) await setEnrollments(tx, auth.tenantId, id, b.courseIds);
    await audit(tx, auth, 'person.create', `user:${id}`, { role: b.role, rollNo: b.rollNo ?? null });
    return id;
  }

  app.post('/v1/staff/people', async (req): Promise<Person> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const b = PersonBody.parse(req.body);
    try {
      const id = await withTx(deps.db, (tx) => createPerson(tx, auth, b));
      return loadPerson(deps.db, auth.tenantId, id);
    } catch (err) {
      const msg = conflictMessage(err);
      if (msg) throw new ApiError(409, 'CONFLICT', msg);
      throw err;
    }
  });

  app.post('/v1/staff/people/import', async (req): Promise<BulkImportResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const b = BulkImportBody.parse(req.body);
    const skipped: BulkImportResponse['skipped'] = [];
    let created = 0;
    for (let i = 0; i < b.rows.length; i++) {
      const raw = b.rows[i] as Record<string, unknown>;
      const parsed = PersonBody.safeParse({ role: 'student', ...raw, courseIds: b.courseIds });
      if (!parsed.success) {
        skipped.push({ row: i + 1, reason: parsed.error.issues[0]?.message ?? 'invalid row' });
        continue;
      }
      try {
        await withTx(deps.db, (tx) => createPerson(tx, auth, parsed.data));
        created++;
      } catch (err) {
        skipped.push({ row: i + 1, reason: conflictMessage(err) ?? 'could not be saved' });
      }
    }
    return { created, skipped };
  });

  app.post('/v1/staff/people/:id', async (req): Promise<Person> => {
    const auth = await requireDevice(req, deps, STAFF);
    requireAdmin(auth);
    const { id } = IdParam.parse(req.params);
    const b = PersonUpdateBody.parse(req.body);
    if (id === auth.userId && b.status === 'suspended') throw new ApiError(400, 'BAD_REQUEST', 'You cannot suspend your own account.');
    try {
      await withTx(deps.db, async (tx) => {
        const cur = await tx.query<{ role: string }>('select role from users where id = $1 and tenant_id = $2 for update', [id, auth.tenantId]);
        if (!cur.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Person not found.');
        if (cur.rows[0].role === 'developer') throw new ApiError(403, 'FORBIDDEN');
        const has = (k: keyof typeof b) => Object.prototype.hasOwnProperty.call(b, k);
        await tx.query(
          `update users set
             full_name = coalesce($2, full_name),
             email = case when $3 then $4 else email end,
             phone = case when $5 then $6 else phone end,
             roll_no = case when $7 then $8 else roll_no end,
             department = case when $9 then $10 else department end,
             semester = case when $11 then $12::int else semester end,
             status = coalesce($13, status)
           where id = $1`,
          [
            id,
            b.fullName ?? null,
            has('email'),
            b.email ?? null,
            has('phone'),
            b.phone ?? null,
            has('rollNo'),
            b.rollNo ?? null,
            has('department'),
            b.department ?? null,
            has('semester'),
            b.semester ?? null,
            b.status ?? null,
          ],
        );
        const check = await tx.query<{ ok: boolean }>('select (email is not null or phone is not null) as ok from users where id = $1', [id]);
        if (!check.rows[0]?.ok) throw new ApiError(400, 'BAD_REQUEST', 'Keep an email or phone number so the person can sign in.');
        if (b.courseIds && cur.rows[0].role === 'student') await setEnrollments(tx, auth.tenantId, id, b.courseIds);
        if (b.status === 'suspended')
          await tx.query(`update auth_sessions set revoked_at = $2, revoke_reason = 'suspended' where user_id = $1 and revoked_at is null`, [id, now()]);
        let reset: string | null = null;
        if (b.resetDevice) reset = await revokeActiveDevice(tx, id, 'reset by admin', now());
        await audit(tx, auth, 'person.update', `user:${id}`, { fields: Object.keys(b), ...(reset ? { deviceReset: reset } : {}) });
      });
    } catch (err) {
      const msg = conflictMessage(err);
      if (msg) throw new ApiError(409, 'CONFLICT', msg);
      throw err;
    }
    return loadPerson(deps.db, auth.tenantId, id);
  });
}

export { institution as loadInstitution, conflictMessage, audit as staffAudit };
