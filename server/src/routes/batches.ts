/**
 * Batches — the top of the academic hierarchy: department + semester → students → subjects.
 *
 * Rules:
 *  • Every teacher and admin can read every batch of their institution, create batches, and add
 *    students and subjects to any batch (students are enrolled in the batch's subjects automatically).
 *  • Removing students or subjects, renaming, archiving, or changing the semester is for admins and
 *    the teacher who created the batch.
 *  • A batch's semester/department is copied onto its students, so "Sem 5" is always true for them.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Batch, BatchBody, BatchDetail, BatchSubjectBody, BatchUpdateBody, type BatchCourse, type StudentHit } from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { STAFF, isAdmin } from '../lib/access';
import { requireDevice, type AuthContext } from '../lib/auth';
import { reconcileBatchEnrollments } from '../lib/batches';
import { ApiError } from '../lib/errors';
import { staffAudit } from './staff-admin';

const IdParam = z.object({ id: z.uuid() });

interface BatchRow {
  id: string;
  name: string;
  active: boolean;
  department: string | null;
  semester: number | null;
  created_by: string | null;
  size: number;
  course_ids: string[];
}

const canManage = (auth: AuthContext, createdBy: string | null) => isAdmin(auth) || (createdBy !== null && createdBy === auth.userId);

export async function loadBatch(db: Queryable, auth: AuthContext, id: string, forUpdate = false): Promise<Batch> {
  if (forUpdate) await db.query('select 1 from batches where id = $1 and tenant_id = $2 for update', [id, auth.tenantId]);
  const { rows } = await db.query<BatchRow>(
    `select b.id, b.name, b.active, b.department, b.semester, b.created_by,
            (select count(*)::int from batch_members m where m.batch_id = b.id) as size,
            coalesce((select array_agg(cb.course_id order by cb.course_id) from course_batches cb where cb.batch_id = b.id), '{}') as course_ids
       from batches b where b.id = $1 and b.tenant_id = $2`,
    [id, auth.tenantId],
  );
  const b = rows[0];
  if (!b) throw new ApiError(404, 'NOT_FOUND', 'Batch not found.');
  return {
    id: b.id,
    name: b.name,
    active: b.active,
    size: b.size,
    courseIds: b.course_ids,
    department: b.department,
    semester: b.semester,
    createdBy: b.created_by,
    canManage: canManage(auth, b.created_by),
  };
}

async function loadDetail(db: Queryable, auth: AuthContext, id: string): Promise<BatchDetail> {
  const b = await loadBatch(db, auth, id);
  const [members, courses] = await Promise.all([
    db.query<{ id: string; full_name: string; roll_no: string | null }>(
      `select u.id, u.full_name, u.roll_no from batch_members m join users u on u.id = m.user_id where m.batch_id = $1 order by u.roll_no nulls last, u.full_name`,
      [id],
    ),
    db.query<{ id: string; code: string; title: string; kind: BatchCourse['kind']; instructor_id: string | null; instructor_name: string | null }>(
      `select c.id, c.code, c.title, c.kind, c.instructor_id, i.full_name as instructor_name
         from course_batches cb join courses c on c.id = cb.course_id left join users i on i.id = c.instructor_id
        where cb.batch_id = $1 order by c.code`,
      [id],
    ),
  ]);
  return {
    ...b,
    members: members.rows.map((r) => ({ userId: r.id, fullName: r.full_name, rollNo: r.roll_no })),
    courses: courses.rows.map((c) => ({
      id: c.id,
      code: c.code,
      title: c.title,
      kind: c.kind,
      instructor: c.instructor_id && c.instructor_name ? { id: c.instructor_id, name: c.instructor_name } : null,
      canOpen: isAdmin(auth) || c.instructor_id === auth.userId,
    })),
  };
}

/** Copies the batch's semester / department onto these students (or all its students). */
async function syncStudentInfo(tx: Queryable, batchId: string, userIds?: string[]) {
  await tx.query(
    `update users u set semester = coalesce(b.semester, u.semester), department = coalesce(b.department, u.department)
       from batches b, batch_members m
      where b.id = $1 and m.batch_id = b.id and m.user_id = u.id and ($2::uuid[] is null or u.id = any($2::uuid[]))
        and (b.semester is not null or b.department is not null)`,
    [batchId, userIds ?? null],
  );
}

const duplicate = (err: unknown) => (err as { code?: string }).code === '23505';

export async function batchRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/v1/staff/batches', async (req): Promise<Batch[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { rows } = await deps.db.query<{ id: string }>('select id from batches where tenant_id = $1 order by active desc, semester nulls last, name', [auth.tenantId]);
    return Promise.all(rows.map((r) => loadBatch(deps.db, auth, r.id)));
  });

  /** Any active student of the institution by name or roll no. (to add to a batch). */
  app.get('/v1/staff/students/search', async (req): Promise<StudentHit[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const q = z.object({ q: z.string().trim().max(60).default(''), notInBatch: z.uuid().optional() }).parse(req.query);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const { rows } = await deps.db.query<{ id: string; full_name: string; roll_no: string | null; department: string | null; semester: number | null; batches: string[] }>(
      `select u.id, u.full_name, u.roll_no, u.department, u.semester,
              coalesce((select array_agg(b.name order by b.name) from batch_members m join batches b on b.id = m.batch_id where m.user_id = u.id), '{}') as batches
         from users u
        where u.tenant_id = $1 and u.role = 'student' and u.status = 'active'
          and ($2::text is null or u.full_name ilike $2 or u.roll_no ilike $2)
          and ($3::uuid is null or not exists (select 1 from batch_members m where m.user_id = u.id and m.batch_id = $3))
        order by u.roll_no nulls last, u.full_name
        limit 200`,
      [auth.tenantId, like, q.notInBatch ?? null],
    );
    return rows.map((r) => ({ userId: r.id, fullName: r.full_name, rollNo: r.roll_no, department: r.department, semester: r.semester, batches: r.batches }));
  });

  app.get('/v1/staff/batches/:id', async (req): Promise<BatchDetail> => {
    const auth = await requireDevice(req, deps, STAFF);
    return loadDetail(deps.db, auth, IdParam.parse(req.params).id);
  });

  app.post('/v1/staff/batches', async (req): Promise<Batch> => {
    const auth = await requireDevice(req, deps, STAFF);
    const b = BatchBody.parse(req.body);
    try {
      const id = await withTx(deps.db, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          'insert into batches(tenant_id, name, active, department, semester, created_by) values ($1, $2, $3, $4, $5, $6) returning id',
          [auth.tenantId, b.name, b.active, b.department ?? null, b.semester ?? null, auth.userId],
        );
        await staffAudit(tx, auth, 'batch.create', `batch:${rows[0]!.id}`, { name: b.name, semester: b.semester ?? null });
        return rows[0]!.id;
      });
      return loadBatch(deps.db, auth, id);
    } catch (err) {
      if (duplicate(err)) throw new ApiError(409, 'CONFLICT', `A batch called “${b.name}” already exists.`);
      throw err;
    }
  });

  app.post('/v1/staff/batches/:id', async (req): Promise<BatchDetail> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const b = BatchUpdateBody.parse(req.body);
    try {
      await withTx(deps.db, async (tx) => {
        const cur = await loadBatch(tx, auth, id, true);
        const courses = b.courseIds ? [...new Set(b.courseIds)] : null;
        if (!cur.canManage) {
          const removesCourse = courses !== null && cur.courseIds.some((c) => !courses.includes(c));
          const changes =
            (b.name !== undefined && b.name !== cur.name) ||
            (b.active !== undefined && b.active !== cur.active) ||
            (b.department !== undefined && b.department !== cur.department) ||
            (b.semester !== undefined && b.semester !== cur.semester) ||
            b.removeMembers.length > 0 ||
            removesCourse;
          if (changes)
            throw new ApiError(403, 'FORBIDDEN', 'Only an admin or the teacher who created this batch can remove students or subjects, rename it, archive it or change its semester. You can add students and subjects.');
        }
        if (b.name !== undefined || b.active !== undefined || b.department !== undefined || b.semester !== undefined)
          await tx.query(
            `update batches set name = coalesce($2, name), active = coalesce($3, active),
                    department = case when $4 then $5 else department end,
                    semester = case when $6 then $7::int else semester end
              where id = $1`,
            [id, b.name ?? null, b.active ?? null, b.department !== undefined, b.department ?? null, b.semester !== undefined, b.semester ?? null],
          );
        const add = [...new Set(b.addMembers)];
        if (add.length) {
          const ok = await tx.query(`select 1 from users where tenant_id = $1 and role = 'student' and id = any($2::uuid[])`, [auth.tenantId, add]);
          if (ok.rowCount !== add.length) throw new ApiError(400, 'BAD_REQUEST', 'Only students of this institution can be in a batch.');
          await tx.query('insert into batch_members(batch_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing', [id, add]);
        }
        if (b.removeMembers.length) await tx.query('delete from batch_members where batch_id = $1 and user_id = any($2::uuid[])', [id, b.removeMembers]);
        if (courses) {
          if (courses.length) {
            const ok = await tx.query('select 1 from courses where tenant_id = $1 and id = any($2::uuid[])', [auth.tenantId, courses]);
            if (ok.rowCount !== courses.length) throw new ApiError(400, 'BAD_REQUEST', 'One or more subjects do not exist.');
          }
          await tx.query('delete from course_batches where batch_id = $1 and not (course_id = any($2::uuid[]))', [id, courses]);
          await tx.query('insert into course_batches(course_id, batch_id) select unnest($2::uuid[]), $1 on conflict do nothing', [id, courses]);
        }
        // New semester / department → every student of the batch; new students → the batch's.
        if (b.semester !== undefined || b.department !== undefined) await syncStudentInfo(tx, id);
        else if (add.length) await syncStudentInfo(tx, id, add);
        await reconcileBatchEnrollments(tx, auth.tenantId);
        await staffAudit(tx, auth, 'batch.update', `batch:${id}`, {
          added: add.length,
          removed: b.removeMembers.length,
          courses: courses?.length ?? null,
          name: b.name ?? null,
          semester: b.semester ?? null,
        });
      });
    } catch (err) {
      if (duplicate(err)) throw new ApiError(409, 'CONFLICT', 'Another batch already has that name.');
      throw err;
    }
    return loadDetail(deps.db, auth, id);
  });

  /** Creates a subject inside a batch. A teacher becomes its instructor; an admin may pick one. */
  app.post('/v1/staff/batches/:id/subjects', async (req): Promise<BatchDetail> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const b = BatchSubjectBody.parse(req.body);
    const instructorId = isAdmin(auth) ? (b.instructorId ?? null) : auth.userId;
    if (instructorId) {
      const r = await deps.db.query(`select 1 from users where id = $1 and tenant_id = $2 and role in ('teacher', 'admin') and status = 'active'`, [instructorId, auth.tenantId]);
      if (r.rowCount !== 1) throw new ApiError(400, 'BAD_REQUEST', 'The teacher must be an active teacher or admin of this institution.');
    }
    try {
      await withTx(deps.db, async (tx) => {
        const batch = await loadBatch(tx, auth, id, true);
        if (!batch.active) throw new ApiError(409, 'CONFLICT', 'This batch is archived. Re-activate it first.');
        const { rows } = await tx.query<{ id: string }>(
          `insert into courses(tenant_id, code, title, kind, instructor_id) values ($1, $2, $3, $4, $5) returning id`,
          [auth.tenantId, b.code, b.title, b.kind, instructorId],
        );
        const courseId = rows[0]!.id;
        await tx.query('insert into course_batches(course_id, batch_id) values ($1, $2)', [courseId, id]);
        await reconcileBatchEnrollments(tx, auth.tenantId);
        await staffAudit(tx, auth, 'course.create', `course:${courseId}`, { code: b.code, batch: id });
      });
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'courses_tenant_id_code_key')
        throw new ApiError(409, 'CONFLICT', `A subject with code ${b.code} already exists — add it from the list instead.`);
      throw err;
    }
    return loadDetail(deps.db, auth, id);
  });
}
