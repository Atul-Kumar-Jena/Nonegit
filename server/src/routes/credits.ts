/**
 * Attendance credit: counting missed classes as attended for a reason (medical leave, a fest,
 * sports, college duty…) with a note. Admins and staff with "Subjects & batches" may credit any
 * subject; a professor credits the subjects they teach. The student is told, and it can be undone.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CREDIT_REASONS, CreditBody, type CreditEntry, type CreditResult, type MissedClass } from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { STAFF, can } from '../lib/access';
import { requireDevice, type AuthContext } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { insertNotifications } from '../lib/notify';
import { signReceipt } from '../lib/receipts';
import { attendancePercent } from '@attendly/protocol';
import { courseStats, loadTenantTerm, type TenantTerm } from '../lib/stats';
import { staffAudit } from './staff-admin';

const IdParam = z.object({ id: z.uuid() });
const MissedQuery = z.object({ courseId: z.uuid().optional() });

interface Missed {
  session_id: string;
  course_id: string;
  code: string;
  scheduled_start: Date;
  lecture_no: number | null;
}

/** The student's subjects this staff member may credit (null = every subject of theirs). */
async function creditableCourses(db: Queryable, auth: AuthContext, studentId: string): Promise<{ id: string; code: string }[]> {
  const { rows } = await db.query<{ id: string; code: string; instructor_id: string | null }>(
    `select c.id, c.code, c.instructor_id from enrollments e join courses c on c.id = e.course_id join users u on u.id = e.user_id
      where e.user_id = $1 and u.tenant_id = $2 and u.role = 'student' order by c.code`,
    [studentId, auth.tenantId],
  );
  return can(auth, 'courses') ? rows : rows.filter((r) => r.instructor_id === auth.userId);
}

/** Held classes of this term the student has no attendance for, most recent first. */
async function missedClasses(db: Queryable, studentId: string, courseIds: string[], term: TenantTerm, from?: string, to?: string): Promise<Missed[]> {
  if (!courseIds.length) return [];
  const { rows } = await db.query<Missed>(
    `select s.id as session_id, s.course_id, c.code, s.scheduled_start, s.lecture_no
       from class_sessions s join courses c on c.id = s.course_id
      where s.course_id = any($2::uuid[]) and s.status = 'closed'
        and s.scheduled_start >= ($3::date::timestamp at time zone $4)
        and ($5::date is null or (s.scheduled_start at time zone $4)::date >= $5::date)
        and ($6::date is null or (s.scheduled_start at time zone $4)::date <= $6::date)
        and not exists (select 1 from attendance_records a where a.session_id = s.id and a.user_id = $1 and a.revoked_at is null)
      order by s.scheduled_start desc`,
    [studentId, courseIds, term.term_start, term.timezone, from ?? null, to ?? null],
  );
  return rows;
}

export async function creditRoutes(app: FastifyInstance, deps: Deps) {
  /** Missed classes that could be credited (for "pick classes"). */
  app.get('/v1/staff/students/:id/missed', async (req): Promise<MissedClass[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const q = MissedQuery.parse(req.query);
    const courses = await creditableCourses(deps.db, auth, id);
    const ids = courses.map((c) => c.id).filter((c) => !q.courseId || c === q.courseId);
    const term = await loadTenantTerm(deps.db, auth.tenantId);
    return (await missedClasses(deps.db, id, ids, term)).map((m) => ({
      sessionId: m.session_id,
      courseId: m.course_id,
      code: m.code,
      scheduledStart: m.scheduled_start.toISOString(),
      lectureNo: m.lecture_no,
    }));
  });

  app.get('/v1/staff/students/:id/credits', async (req): Promise<CreditEntry[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const { rows } = await deps.db.query<{
      id: string;
      reason: CreditEntry['reason'];
      note: string;
      code: string | null;
      requested: string;
      credited: number;
      by: string | null;
      created_at: Date;
      undone_at: Date | null;
    }>(
      `select k.id, k.reason, k.note, c.code, k.requested, k.credited, u.full_name as by, k.created_at, k.undone_at
         from attendance_credits k left join courses c on c.id = k.course_id left join users u on u.id = k.created_by
        where k.user_id = $1 and k.tenant_id = $2 order by k.created_at desc limit 100`,
      [id, auth.tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      note: r.note,
      subject: r.code,
      requested: r.requested,
      credited: r.credited,
      by: r.by,
      createdAt: r.created_at.toISOString(),
      undone: !!r.undone_at,
    }));
  });

  app.post('/v1/staff/students/:id/credit', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<CreditResult> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const b = CreditBody.parse(req.body);
    const allowed = await creditableCourses(deps.db, auth, id);
    if (!allowed.length) throw new ApiError(403, 'FORBIDDEN', 'You can give credit only in the subjects you teach (admins: any subject).');
    if (b.courseId && !allowed.some((c) => c.id === b.courseId)) throw new ApiError(403, 'FORBIDDEN', 'You can give credit only in the subjects you teach.');
    if (!b.courseId && !can(auth, 'courses')) throw new ApiError(403, 'FORBIDDEN', 'Crediting every subject at once needs the “Subjects & batches” permission. Pick one of your subjects.');
    const courses = b.courseId ? allowed.filter((c) => c.id === b.courseId) : allowed;
    const term = await loadTenantTerm(deps.db, auth.tenantId);
    const t = new Date(deps.clock());

    return withTx(deps.db, async (tx) => {
      // Per-user lock: two credits at once can't double-count.
      await tx.query(`select pg_advisory_xact_lock(hashtext('credit:' || $1))`, [id]);
      const missed = await missedClasses(tx, id, courses.map((c) => c.id), term, b.from, b.to);
      const stats = new Map((await courseStats(tx, id, term)).map((s) => [s.course_id, s]));
      const picked: Missed[] = [];
      if (b.amount.kind === 'sessions') {
        const want = new Set(b.amount.sessionIds);
        const found = missed.filter((m) => want.has(m.session_id));
        if (found.length !== want.size) throw new ApiError(400, 'BAD_REQUEST', 'Some of those classes aren’t missed classes of this student in your subjects.');
        picked.push(...found);
      } else
        for (const c of courses) {
          const mine = missed.filter((m) => m.course_id === c.id);
          const held = stats.get(c.id)?.held ?? 0;
          const n = b.amount.kind === 'classes' ? b.amount.classes : Math.ceil((b.amount.percent / 100) * held - 1e-9);
          picked.push(...mine.slice(0, Math.max(0, n)));
        }
      const perSubject = courses
        .map((c) => {
          const s = stats.get(c.id);
          const n = picked.filter((p) => p.course_id === c.id).length;
          return {
            courseId: c.id,
            code: c.code,
            credited: n,
            before: s ? attendancePercent(s.attended, s.held) : null,
            after: s ? attendancePercent(s.attended + n, s.held) : null,
          };
        })
        .filter((x) => x.credited > 0 || b.courseId);
      if (b.preview || !picked.length) return { preview: true, credited: picked.length, perSubject, creditId: null };

      const requested =
        (b.amount.kind === 'classes' ? `${b.amount.classes} ${b.amount.classes === 1 ? 'class' : 'classes'}` : b.amount.kind === 'percent' ? `${b.amount.percent}%` : `${b.amount.sessionIds.length} chosen classes`) +
        (b.amount.kind !== 'sessions' && !b.courseId ? ' per subject' : '');
      const credit = (
        await tx.query<{ id: string }>(
          `insert into attendance_credits(tenant_id, user_id, course_id, reason, note, requested, credited, created_by, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [auth.tenantId, id, b.courseId, b.reason, b.note, requested + (b.from || b.to ? ` (${b.from ?? '…'} → ${b.to ?? '…'})` : ''), picked.length, auth.userId, t],
        )
      ).rows[0]!.id;
      const fp = `credit:${auth.deviceFingerprint}`;
      for (const m of picked) {
        const recordId = (await tx.query<{ id: string }>('select gen_random_uuid() as id')).rows[0]!.id;
        const markedAt = m.scheduled_start;
        await tx.query(
          `insert into attendance_records(id, session_id, user_id, marked_at, qr_seq, receipt_signature, server_key_id, device_fingerprint, source, marked_by, credit_id)
           values ($1, $2, $3, $4, 0, $5, $6, $7, 'credit', $8, $9)
           on conflict (session_id, user_id) do update
             set revoked_at = null, revoked_by = null, revoke_reason = null, source = 'credit', marked_by = excluded.marked_by, credit_id = excluded.credit_id
           where attendance_records.revoked_at is not null`,
          [recordId, m.session_id, id, markedAt, signReceipt(deps.signer, { recordId, sessionId: m.session_id, userId: id, markedAt, deviceFingerprint: fp, qrSeq: 0 }), deps.signer.kid, fp, auth.userId, credit],
        );
      }
      await staffAudit(tx, auth, 'attendance.credit', `user:${id}`, { credit, reason: b.reason, requested, credited: picked.length, course: b.courseId });
      const label = CREDIT_REASONS[b.reason];
      const lines = perSubject.filter((p) => p.credited > 0).map((p) => `${p.code}: +${p.credited} → ${p.after ?? '—'}%`);
      await insertNotifications(tx, auth.tenantId, [
        {
          userId: id,
          kind: 'attendance',
          title: `🎖 Attendance credit · ${label}`,
          body: `${picked.length} ${picked.length === 1 ? 'class' : 'classes'} counted as attended.\n${lines.join(' · ')}\nNote: ${b.note}`,
          data: { creditId: credit, ...(b.courseId ? { courseId: b.courseId } : {}) },
        },
      ]);
      return { preview: false, credited: picked.length, perSubject, creditId: credit };
    });
  });

  /** Takes a credit back: its classes are unmarked again. */
  app.post('/v1/staff/credits/:id/undo', async (req) => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    return withTx(deps.db, async (tx) => {
      const k = (
        await tx.query<{ user_id: string; course_id: string | null; created_by: string | null; undone_at: Date | null }>(
          'select user_id, course_id, created_by, undone_at from attendance_credits where id = $1 and tenant_id = $2 for update',
          [id, auth.tenantId],
        )
      ).rows[0];
      if (!k) throw new ApiError(404, 'NOT_FOUND', 'Credit not found.');
      if (k.undone_at) throw new ApiError(409, 'CONFLICT', 'This credit was already undone.');
      if (!can(auth, 'courses') && k.created_by !== auth.userId) throw new ApiError(403, 'FORBIDDEN', 'Only whoever gave this credit, or an admin, can undo it.');
      const t = new Date(deps.clock());
      await tx.query(`update attendance_records set revoked_at = $2, revoked_by = $3, revoke_reason = 'Attendance credit undone' where credit_id = $1 and revoked_at is null`, [id, t, auth.userId]);
      await tx.query('update attendance_credits set undone_at = $2, undone_by = $3 where id = $1', [id, t, auth.userId]);
      await staffAudit(tx, auth, 'attendance.credit_undo', `user:${k.user_id}`, { credit: id });
      return { ok: true as const };
    });
  });
}
