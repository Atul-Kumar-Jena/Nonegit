/**
 * Institute app — running classes: start/end (online or synced from offline), live feed,
 * the manual register, offline packs, suspicious-scan review and device requests.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateSessionBody,
  DecisionBody,
  EndSessionBody,
  ManualBody,
  ReviewBody,
  StartSessionBody,
  YMD,
  keyFingerprint,
  toB64url,
  type DeviceInfo,
  type DeviceRequestItem,
  type FeedEntry,
  type FlagEntry,
  type ManualResponse,
  type OfflinePack,
  type SessionFeed,
  type SessionWithSecret,
  type StaffSession,
} from '@attendly/protocol';
import type { PoolClient } from 'pg';
import type { Deps } from '../deps';
import { decidableStudents } from '../lib/mentors';
import { markShowing } from '../lib/class-clock';
import { insertNotifications } from '../lib/notify';
import { assertPhoneFree, hardwareHash } from '../lib/users';
import { tenantFlag } from '../lib/flags';
import { withTx, type Queryable } from '../db';
import { STAFF, can, instructorFilter, isAdmin, loadCourseFor, loadSessionFor, requirePerm, type SessionAccessRow } from '../lib/access';
import { perDeviceKey, requireDevice, type AuthContext } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { signReceipt } from '../lib/receipts';
import { assignLectureNo, createSession } from '../lib/sessions';
import { listStaffSessions, loadStaffSession, localDayBounds } from '../lib/staff-sessions';
import { deliverChanges, fmtWhen } from '../lib/notify';
import { publishOps } from '../lib/planner-server';
import { loadRoster } from './staff-academics';
import { loadInstitution, revokeActiveDevice, staffAudit } from './staff-admin';

const IdParam = z.object({ id: z.uuid() });
/** Teachers may (re)take a register up to this long after the class; admins any time. */
const TEACHER_EDIT_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** An offline-started class may claim a start this long before its scheduled time. */
const EARLY_START_MS = 2 * 60 * 60_000;

async function idempotent<T>(tx: PoolClient, auth: AuthContext, clientRef: string | undefined, kind: string, fn: () => Promise<T>): Promise<{ result: T; duplicate: boolean }> {
  if (!clientRef) return { result: await fn(), duplicate: false };
  const prior = await tx.query<{ result: T }>('select result from client_actions where user_id = $1 and client_ref = $2', [auth.userId, clientRef]);
  if (prior.rows[0]) return { result: prior.rows[0].result, duplicate: true };
  const result = await fn();
  await tx.query('insert into client_actions(user_id, client_ref, kind, result) values ($1, $2, $3, $4)', [auth.userId, clientRef, kind, JSON.stringify(result)]);
  return { result, duplicate: false };
}

async function withSecret(db: Queryable, s: SessionAccessRow, session?: StaffSession): Promise<SessionWithSecret> {
  const full = session ?? (await loadStaffSession(db, s.id));
  const reveal = full.mode === 'qr' && (full.status === 'live' || full.status === 'scheduled');
  return { session: full, secret: reveal ? toB64url(s.qr_secret) : null };
}

export async function staffSessionRoutes(app: FastifyInstance, deps: Deps) {
  const now = () => deps.clock();

  app.get('/v1/staff/sessions', async (req): Promise<StaffSession[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const q = z.object({ date: YMD.optional(), days: z.coerce.number().int().min(1).max(31).default(1), courseId: z.uuid().optional() }).parse(req.query);
    const inst = await loadInstitution(deps.db, auth.tenantId);
    const range = await localDayBounds(deps.db, inst.timezone, q.date ?? null, q.days);
    if (q.courseId) await loadCourseFor(deps.db, auth, q.courseId);
    return listStaffSessions(deps.db, { tenantId: auth.tenantId, instructorId: instructorFilter(auth), from: range.from, to: range.to, courseId: q.courseId ?? null });
  });

  /** Recent + upcoming classes of one course (course detail screen). */
  app.get('/v1/staff/courses/:id/sessions', async (req): Promise<StaffSession[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    await loadCourseFor(deps.db, auth, id);
    return listStaffSessions(deps.db, {
      tenantId: auth.tenantId,
      instructorId: instructorFilter(auth),
      from: new Date(now() - 120 * 86_400_000),
      to: new Date(now() + 14 * 86_400_000),
      courseId: id,
    });
  });

  /** Extra / make-up class outside the weekly timetable. */
  app.post('/v1/staff/sessions', async (req): Promise<StaffSession> => {
    const auth = await requireDevice(req, deps, STAFF);
    const b = CreateSessionBody.parse(req.body);
    await loadCourseFor(deps.db, auth, b.courseId);
    const inst = await loadInstitution(deps.db, auth.tenantId);
    const t = await deps.db.query<{ starts: Date; ends: Date }>(
      `select (($1::date + $2::time) at time zone $4) as starts, (($1::date + $3::time) at time zone $4) as ends`,
      [b.date, b.start, b.end, inst.timezone],
    );
    const { starts, ends } = t.rows[0]!;
    if (starts.getTime() < now() - 14 * 86_400_000 || starts.getTime() > now() + 90 * 86_400_000)
      throw new ApiError(400, 'BAD_REQUEST', 'Extra classes can be added from 14 days ago up to 90 days ahead.');
    let room: { id: string; name: string; lat: number | null; lng: number | null; radius_m: number } | undefined;
    if (b.roomId) {
      const r = await deps.db.query<{ id: string; name: string; lat: number | null; lng: number | null; radius_m: number }>(
        'select id, name, lat, lng, radius_m from rooms where id = $1 and tenant_id = $2',
        [b.roomId, auth.tenantId],
      );
      room = r.rows[0];
      if (!room) throw new ApiError(400, 'BAD_REQUEST', 'Unknown room.');
    }
    const created = await withTx(deps.db, async (tx) => {
      const c = await createSession(tx, {
        tenantId: auth.tenantId,
        courseId: b.courseId,
        room: room?.name ?? null,
        lat: room?.lat ?? null,
        lng: room?.lng ?? null,
        radiusM: room?.radius_m ?? 50,
        rotationS: b.rotationS,
        status: 'scheduled',
        scheduledStart: starts,
        scheduledEnd: ends,
        startedAt: null,
        createdBy: auth.userId,
        mode: b.mode,
        roomId: room?.id ?? null,
        changeKind: starts.getTime() > now() ? 'extra' : null,
      });
      // A future extra class is news for the students of the course.
      if (starts.getTime() > now()) {
        const course = await loadCourseFor(tx, auth, b.courseId);
        const line = { kind: 'extra' as const, courseId: b.courseId, courseCode: course.code, sessionId: c.id, text: `Extra ${course.code} class: ${fmtWhen(starts, inst.timezone)}${room ? ` · ${room.name}` : ''}` };
        // …and for its professor, when someone else scheduled it.
        const staff = course.instructor_id && course.instructor_id !== auth.userId ? new Map([[course.instructor_id, [line]]]) : undefined;
        await deliverChanges(tx, auth.tenantId, [line], staff);
      }
      return c;
    });
    return loadStaffSession(deps.db, created.id);
  });

  /** The professor's phone is showing this class's QR (sent when opened, then every 30 s). */
  app.post('/v1/staff/sessions/:id/showing', { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: perDeviceKey } } }, async (req) => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    await loadSessionFor(deps.db, auth, id, true);
    await markShowing(deps.db, id, new Date(now()));
    return { ok: true as const };
  });

  app.get('/v1/staff/sessions/:id', async (req): Promise<SessionWithSecret> => {
    const auth = await requireDevice(req, deps, STAFF);
    const s = await loadSessionFor(deps.db, auth, IdParam.parse(req.params).id);
    return withSecret(deps.db, s);
  });

  app.post('/v1/staff/sessions/:id/start', async (req): Promise<SessionWithSecret> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const b = StartSessionBody.parse(req.body);
    const t = now();
    return withTx(deps.db, async (tx) => {
      const s = await loadSessionFor(tx, auth, id, true);
      const { result } = await idempotent(tx, auth, b.clientRef, 'session.start', async () => {
        if (s.status === 'live') return { already: true };
        if (s.status !== 'scheduled') throw new ApiError(409, 'CONFLICT', `This class is already ${s.status}.`);
        const startedAt = b.startedAt ?? t;
        if (startedAt > t + 90_000 || startedAt < s.scheduled_start.getTime() - EARLY_START_MS)
          throw new ApiError(400, 'BAD_REQUEST', 'The start time is outside this class’s schedule.');
        const lat = b.lat ?? s.lat;
        const lng = b.lng ?? s.lng;
        if (b.mode === 'qr' && (lat == null || lng == null))
          throw new ApiError(400, 'BAD_REQUEST', 'A QR class needs a location: allow location on this phone or save the room’s location first.');
        await tx.query(
          `update class_sessions set status = 'live', mode = $2, lat = $3, lng = $4, radius_m = $5, rotation_s = $6, started_at = $7, started_by = $8,
                  center_accuracy_m = case when $9 then $10 else center_accuracy_m end
            where id = $1`,
          [
            id,
            b.mode,
            lat,
            lng,
            b.radiusM ?? s.radius_m,
            b.rotationS ?? s.rotation_s,
            new Date(startedAt),
            auth.userId,
            b.lat != null,
            b.lat != null ? (b.centerAccuracyM ?? null) : null,
          ],
        );
        await assignLectureNo(tx, id);
        await staffAudit(tx, auth, 'session.start', `session:${id}`, { mode: b.mode, synced: b.startedAt !== undefined, device: auth.deviceFingerprint });
        return { already: false };
      });
      void result;
      const fresh = await tx.query<SessionAccessRow>(
        `select s.*, c.instructor_id from class_sessions s join courses c on c.id = s.course_id where s.id = $1`,
        [id],
      );
      return withSecret(tx, fresh.rows[0]!, await loadStaffSession(tx, id));
    });
  });

  app.post('/v1/staff/sessions/:id/end', async (req): Promise<StaffSession> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const b = EndSessionBody.parse(req.body ?? {});
    const t = now();
    await withTx(deps.db, async (tx) => {
      const s = await loadSessionFor(tx, auth, id, true);
      await idempotent(tx, auth, b.clientRef, 'session.end', async () => {
        if (s.status === 'closed') return { already: true };
        if (s.status !== 'live') throw new ApiError(409, 'CONFLICT', 'Only a running class can be ended.');
        const endedAt = Math.min(Math.max(b.endedAt ?? t, s.started_at!.getTime()), t);
        await tx.query(`update class_sessions set status = 'closed', ended_at = $2, ended_by = $3 where id = $1`, [id, new Date(endedAt), auth.userId]);
        await staffAudit(tx, auth, 'session.end', `session:${id}`, { synced: b.endedAt !== undefined });
        return { already: false };
      });
    });
    return loadStaffSession(deps.db, id);
  });

  /** Cancel a class that hasn't happened: students are told why (same engine as the planner). */
  app.post('/v1/staff/sessions/:id/cancel', async (req): Promise<StaffSession> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(200).optional() }).parse(req.body ?? {});
    await withTx(deps.db, async (tx) => {
      const s = await loadSessionFor(tx, auth, id, true);
      if (s.status !== 'scheduled') throw new ApiError(409, 'CONFLICT', 'Only a class that hasn’t started can be cancelled.');
      const marks = await tx.query('select 1 from attendance_records where session_id = $1 limit 1', [id]);
      if (marks.rowCount) throw new ApiError(409, 'CONFLICT', 'This class already has attendance.');
      if (s.scheduled_start.getTime() <= now()) {
        // Already past its start: nothing to tell anyone, just mark it.
        await tx.query(`update class_sessions set status = 'cancelled', change_kind = 'cancelled', change_note = $2, changed_at = $3, changed_by = $4 where id = $1`, [
          id,
          b.reason ?? 'Cancelled',
          new Date(now()),
          auth.userId,
        ]);
        await staffAudit(tx, auth, 'session.cancel', `session:${id}`);
        return;
      }
      const r = await publishOps(tx, deps, auth, [{ op: 'cancel', sessionId: id, reason: b.reason ?? 'Cancelled by the teacher' }], { acceptWarnings: true });
      if (!r.published) throw new ApiError(409, 'CONFLICT', r.errors[0]?.message ?? 'This class can’t be cancelled.');
    });
    return loadStaffSession(deps.db, id);
  });

  async function flagsFor(db: Queryable, auth: AuthContext, where: { sessionId?: string; status?: string }): Promise<FlagEntry[]> {
    const { rows } = await db.query<{
      id: number;
      user_id: string | null;
      full_name: string | null;
      roll_no: string | null;
      code: string;
      detail: Record<string, unknown>;
      review_status: FlagEntry['status'];
      created_at: Date;
      session_id: string | null;
      course_code: string | null;
    }>(
      `select x.id, x.user_id, u.full_name, u.roll_no, x.code, x.detail, x.review_status, x.created_at, x.session_id, c.code as course_code
         from scan_rejections x
         left join users u on u.id = x.user_id
         left join class_sessions s on s.id = x.session_id
         left join courses c on c.id = s.course_id
        where x.tenant_id = $1 and x.suspicious
          and ($2::uuid is null or c.instructor_id = $2)
          and ($3::uuid is null or x.session_id = $3)
          and ($4::text is null or x.review_status = $4)
        order by x.created_at desc limit 300`,
      [auth.tenantId, instructorFilter(auth), where.sessionId ?? null, where.status ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      fullName: r.full_name,
      rollNo: r.roll_no,
      code: r.code,
      detail: r.detail,
      status: r.review_status,
      at: r.created_at.toISOString(),
      sessionId: r.session_id,
      courseCode: r.course_code,
    }));
  }

  app.get('/v1/staff/sessions/:id/feed', async (req): Promise<SessionFeed> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const s = await loadSessionFor(deps.db, auth, id);
    const { rows } = await deps.db.query<{
      id: string;
      full_name: string;
      roll_no: string | null;
      record_id: string | null;
      source: FeedEntry['source'];
      marked_at: Date | null;
      offline: boolean | null;
      distance_m: number | null;
      marked_by: string | null;
      revoked_at: Date | null;
      revoke_reason: string | null;
    }>(
      `select u.id, u.full_name, u.roll_no, a.id as record_id, a.source, a.marked_at, a.offline, a.distance_m, mb.full_name as marked_by,
              a.revoked_at, a.revoke_reason
         from enrollments e
         join users u on u.id = e.user_id and u.role = 'student' and u.status = 'active'
         left join attendance_records a on a.session_id = $2 and a.user_id = u.id
         left join users mb on mb.id = a.marked_by
        where e.course_id = $1
        order by (a.id is not null and a.revoked_at is null) desc, a.marked_at desc nulls last, u.roll_no nulls last, u.full_name`,
      [s.course_id, id],
    );
    return {
      session: await loadStaffSession(deps.db, id),
      entries: rows.map((r) => ({
        userId: r.id,
        fullName: r.full_name,
        rollNo: r.roll_no,
        present: !!r.record_id && !r.revoked_at,
        source: r.source,
        markedAt: r.marked_at?.toISOString() ?? null,
        offline: !!r.offline,
        distanceM: r.distance_m === null ? null : Math.round(r.distance_m),
        markedBy: r.marked_by,
        revokedReason: r.revoked_at ? r.revoke_reason : null,
      })),
      flags: await flagsFor(deps.db, auth, { sessionId: id }),
    };
  });

  /**
   * The manual register. Exactly sets who was present/absent for the students listed.
   * Idempotent per clientRef (offline retries), bounded in time, fully audited, and
   * removing a *scanned* mark requires a written reason.
   */
  app.post('/v1/staff/sessions/:id/register', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<ManualResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const b = ManualBody.parse(req.body);
    const t = now();
    const present = [...new Set(b.present)];
    const absent = [...new Set(b.absent)];
    if (present.some((u) => absent.includes(u))) throw new ApiError(400, 'BAD_REQUEST', 'A student cannot be both present and absent.');
    if (b.recordedAt > t + 90_000) throw new ApiError(400, 'BAD_REQUEST', 'The register is dated in the future. Check the phone’s date & time.');

    return withTx(deps.db, async (tx) => {
      const s = await loadSessionFor(tx, auth, id, true);
      const { result, duplicate } = await idempotent(tx, auth, b.clientRef, 'register', async () => {
        if (s.status === 'cancelled') throw new ApiError(409, 'CONFLICT', 'This class was cancelled.');
        // Corrections to a QR class are always allowed; paper-style classes can be switched off per institution.
        if (s.mode === 'manual' && !(await tenantFlag(tx, auth.tenantId, 'manual_registers')))
          throw new ApiError(403, 'FORBIDDEN', 'Paper-style registers are turned off for your institution. Run this class with the QR code instead.');
        if (s.scheduled_start.getTime() > t + 30 * 60_000) throw new ApiError(400, 'BAD_REQUEST', 'You can’t take a register for a class that hasn’t happened yet.');
        if (!isAdmin(auth) && t - s.scheduled_end.getTime() > TEACHER_EDIT_WINDOW_MS)
          throw new ApiError(403, 'FORBIDDEN', 'Registers older than 14 days can only be changed by an admin.');

        const roster = new Set((await loadRoster(tx, s.course_id)).map((r) => r.userId));
        const unknown = [...present, ...absent].filter((u) => !roster.has(u));
        if (unknown.length) throw new ApiError(400, 'BAD_REQUEST', `${unknown.length} of the listed students are not on this class’s roster.`);

        const existing = await tx.query<{ id: string; user_id: string; source: string; revoked_at: Date | null }>(
          'select id, user_id, source, revoked_at from attendance_records where session_id = $1 for update',
          [id],
        );
        const byUser = new Map(existing.rows.map((r) => [r.user_id, r]));
        const scannedRemovals = absent.filter((u) => {
          const r = byUser.get(u);
          return r && !r.revoked_at && r.source === 'scan';
        });
        if (scannedRemovals.length && !b.note)
          throw new ApiError(400, 'BAD_REQUEST', `Add a note explaining why ${scannedRemovals.length} scanned ${scannedRemovals.length === 1 ? 'mark is' : 'marks are'} being removed.`);

        const recordedAt = new Date(Math.min(b.recordedAt, t));
        const teacherFp = `manual:${auth.deviceFingerprint}`;
        let changed = 0;
        for (const u of present) {
          const r = byUser.get(u);
          if (r && !r.revoked_at) continue;
          if (r) {
            await tx.query('update attendance_records set revoked_at = null, revoked_by = null, revoke_reason = null, marked_by = $2 where id = $1', [r.id, auth.userId]);
          } else {
            const recordId = (await tx.query<{ id: string }>('select gen_random_uuid() as id')).rows[0]!.id;
            const receipt = signReceipt(deps.signer, { recordId, sessionId: id, userId: u, markedAt: recordedAt, deviceFingerprint: teacherFp, qrSeq: 0 });
            await tx.query(
              `insert into attendance_records(id, session_id, user_id, marked_at, qr_seq, receipt_signature, server_key_id, device_fingerprint, source, marked_by, offline)
               values ($1, $2, $3, $4, 0, $5, $6, $7, 'manual', $8, $9)`,
              [recordId, id, u, recordedAt, receipt, deps.signer.kid, teacherFp, auth.userId, t - b.recordedAt > 90_000],
            );
          }
          changed++;
        }
        for (const u of absent) {
          const r = byUser.get(u);
          if (!r || r.revoked_at) continue;
          await tx.query('update attendance_records set revoked_at = $2, revoked_by = $3, revoke_reason = $4 where id = $1', [
            r.id,
            new Date(t),
            auth.userId,
            b.note ? `Marked absent in register: ${b.note}` : 'Marked absent in register',
          ]);
          changed++;
        }
        // Taking the register for a class that never went live records it as held.
        if (s.status === 'scheduled') {
          await tx.query(`update class_sessions set status = 'closed', started_at = scheduled_start, ended_at = scheduled_end, started_by = $2, ended_by = $2 where id = $1`, [
            id,
            auth.userId,
          ]);
          await assignLectureNo(tx, id);
        }
        const counts = await tx.query<{ present: number; enrolled: number }>(
          `select (select count(*) from attendance_records where session_id = $1 and revoked_at is null) as present,
                  (select count(*) from enrollments e join users u on u.id = e.user_id and u.status = 'active' and u.role = 'student' where e.course_id = $2) as enrolled`,
          [id, s.course_id],
        );
        await staffAudit(tx, auth, 'register.save', `session:${id}`, {
          present: present.length,
          absent: absent.length,
          changed,
          scannedRemoved: scannedRemovals.length,
          note: b.note ?? null,
          offline: t - b.recordedAt > 90_000,
        });
        const c = counts.rows[0]!;
        return { present: c.present, absent: Math.max(0, c.enrolled - c.present), changed, duplicate: false };
      });
      return { ...result, duplicate };
    });
  });

  /** Everything a teacher's phone needs to run today's and tomorrow's classes with no internet. */
  app.get('/v1/staff/offline-pack', async (req): Promise<OfflinePack> => {
    const auth = await requireDevice(req, deps, STAFF);
    const inst = await loadInstitution(deps.db, auth.tenantId);
    const range = await localDayBounds(deps.db, inst.timezone, null, 2);
    const sessions = (await listStaffSessions(deps.db, { tenantId: auth.tenantId, instructorId: auth.userId, from: range.from, to: range.to, includeLive: true })).filter(
      (s) => s.status === 'scheduled' || s.status === 'live',
    );
    const secrets = sessions.length
      ? await deps.db.query<{ id: string; qr_secret: Buffer }>('select id, qr_secret from class_sessions where id = any($1::uuid[])', [sessions.map((s) => s.id)])
      : { rows: [] };
    const secretOf = new Map(secrets.rows.map((r) => [r.id, toB64url(r.qr_secret)]));
    const rosters: Record<string, Awaited<ReturnType<typeof loadRoster>>> = {};
    for (const courseId of new Set(sessions.map((s) => s.courseId))) rosters[courseId] = await loadRoster(deps.db, courseId);
    if (sessions.length)
      await withTx(deps.db, (tx) => staffAudit(tx, auth, 'offline_pack.issued', `user:${auth.userId}`, { sessions: sessions.length, device: auth.deviceFingerprint }));
    return {
      generatedAt: now(),
      timezone: inst.timezone,
      sessions: sessions.map((s) => ({ ...s, secret: s.mode === 'qr' ? (secretOf.get(s.id) ?? null) : null })),
      rosters,
    };
  });

  // ── suspicious scans ──
  app.get('/v1/staff/flags', async (req): Promise<FlagEntry[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const q = z.object({ status: z.enum(['open', 'valid', 'blocked', 'dismissed']).optional() }).parse(req.query);
    return flagsFor(deps.db, auth, { status: q.status });
  });

  app.post('/v1/staff/flags/:id', async (req): Promise<FlagEntry> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = ReviewBody.parse(req.body);
    await withTx(deps.db, async (tx) => {
      const { rows } = await tx.query<{ id: number; session_id: string | null; user_id: string | null; review_status: string }>(
        'select id, session_id, user_id, review_status from scan_rejections where id = $1 and tenant_id = $2 for update',
        [id, auth.tenantId],
      );
      const f = rows[0];
      if (!f) throw new ApiError(404, 'NOT_FOUND', 'Flag not found.');
      // Suspicious scans: the class's own teacher, or "Phones & scans".
      if (!can(auth, 'devices')) {
        if (f.session_id) await loadSessionFor(tx, auth, f.session_id);
        else requirePerm(auth, 'devices');
      }
      if (f.review_status !== 'open') throw new ApiError(409, 'CONFLICT', 'This flag was already reviewed.');
      if (b.action === 'valid') {
        if (!f.session_id || !f.user_id) throw new ApiError(400, 'BAD_REQUEST', 'This flag is not linked to a class.');
        const enrolled = await tx.query('select 1 from enrollments e join class_sessions s on s.course_id = e.course_id where s.id = $1 and e.user_id = $2', [
          f.session_id,
          f.user_id,
        ]);
        if (enrolled.rowCount !== 1) throw new ApiError(400, 'BAD_REQUEST', 'The student is not on this class’s roster.');
        const exists = await tx.query<{ id: string; revoked_at: Date | null }>('select id, revoked_at from attendance_records where session_id = $1 and user_id = $2', [
          f.session_id,
          f.user_id,
        ]);
        if (!exists.rows[0]) {
          const recordId = (await tx.query<{ id: string }>('select gen_random_uuid() as id')).rows[0]!.id;
          const markedAt = new Date(now());
          const fp = `review:${auth.deviceFingerprint}`;
          await tx.query(
            `insert into attendance_records(id, session_id, user_id, marked_at, qr_seq, receipt_signature, server_key_id, device_fingerprint, source, marked_by)
             values ($1, $2, $3, $4, 0, $5, $6, $7, 'review', $8)`,
            [recordId, f.session_id, f.user_id, markedAt, signReceipt(deps.signer, { recordId, sessionId: f.session_id, userId: f.user_id, markedAt, deviceFingerprint: fp, qrSeq: 0 }), deps.signer.kid, fp, auth.userId],
          );
        } else if (exists.rows[0].revoked_at) {
          await tx.query('update attendance_records set revoked_at = null, revoked_by = null, revoke_reason = null, marked_by = $2 where id = $1', [exists.rows[0].id, auth.userId]);
        }
      }
      await tx.query('update scan_rejections set review_status = $2, reviewed_by = $3, reviewed_at = $4 where id = $1', [id, b.action, auth.userId, new Date(now())]);
      await staffAudit(tx, auth, 'flag.review', `flag:${id}`, { action: b.action, session: f.session_id, student: f.user_id });
    });
    const [flag] = (await flagsFor(deps.db, auth, {})).filter((x) => x.id === id);
    if (!flag) throw new ApiError(404, 'NOT_FOUND', 'Flag not found.');
    return flag;
  });

  // ── device requests (admin) ──
  app.get('/v1/staff/device-requests', async (req): Promise<DeviceRequestItem[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    // Admins / "devices" holders see every request; batch mentors see their students'.
    const only = await decidableStudents(deps.db, auth);
    if (only && !only.length) requirePerm(auth, 'devices');
    const { rows } = await deps.db.query<{
      id: string;
      kind: 'rebind' | 'reset';
      user_id: string;
      full_name: string;
      roll_no: string | null;
      role: string;
      from_model: string | null;
      from_fp: string | null;
      to_public_key: Buffer | null;
      to_device_info: DeviceInfo | null;
      reason: string;
      created_at: Date;
    }>(
      `select r.id, r.kind, u.id as user_id, u.full_name, u.roll_no, u.role, d.model as from_model, d.fingerprint as from_fp,
              r.to_public_key, r.to_device_info, r.reason, r.created_at
         from device_requests r join users u on u.id = r.user_id left join devices d on d.id = r.from_device_id
        where u.tenant_id = $1 and r.status = 'pending' and ($2::uuid[] is null or u.id = any($2::uuid[])) order by r.created_at`,
      [auth.tenantId, only],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      user: { id: r.user_id, fullName: r.full_name, rollNo: r.roll_no, role: r.role },
      from: r.from_model && r.from_fp ? { model: r.from_model, fingerprint: r.from_fp } : null,
      to:
        r.to_public_key && r.to_device_info
          ? { model: r.to_device_info.model, platform: r.to_device_info.platform, fingerprint: keyFingerprint(r.to_public_key) }
          : null,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
    }));
  });

  app.post('/v1/staff/device-requests/:id', async (req) => {
    const auth = await requireDevice(req, deps, STAFF);
    const only = await decidableStudents(deps.db, auth);
    if (only && !only.length) requirePerm(auth, 'devices');
    const { id } = IdParam.parse(req.params);
    const b = DecisionBody.parse(req.body);
    const t = new Date(now());
    await withTx(deps.db, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        user_id: string;
        kind: 'rebind' | 'reset';
        status: string;
        to_public_key: Buffer | null;
        to_device_info: DeviceInfo | null;
        to_hw_key_spki: Buffer | null;
        to_attest_level: string | null;
        to_attest_patch: number | null;
      }>(
        `select r.id, r.user_id, r.kind, r.status, r.to_public_key, r.to_device_info, r.to_hw_key_spki, r.to_attest_level, r.to_attest_patch
           from device_requests r join users u on u.id = r.user_id where r.id = $1 and u.tenant_id = $2 for update of r`,
        [id, auth.tenantId],
      );
      const r = rows[0];
      if (!r) throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
      if (only && !only.includes(r.user_id)) throw new ApiError(403, 'FORBIDDEN', 'Only this student’s batch mentor or an admin can decide this request.');
      if (r.status !== 'pending') throw new ApiError(409, 'CONFLICT', 'This request was already decided.');
      if (r.user_id === auth.userId && b.decision === 'approve') {
        const others = await tx.query(`select 1 from users where tenant_id = $1 and role = 'admin' and status = 'active' and id <> $2 limit 1`, [auth.tenantId, auth.userId]);
        if (others.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Another admin must approve your own device change.');
      }
      if (b.decision === 'approve') {
        if (r.kind === 'rebind') {
          if (!r.to_public_key || !r.to_device_info) throw new ApiError(400, 'BAD_REQUEST', 'This request has no new device.');
          const taken = await tx.query(`select 1 from devices where public_key = $1 and status = 'active' and user_id <> $2`, [r.to_public_key, r.user_id]);
          if (taken.rowCount) throw new ApiError(409, 'CONFLICT', 'That phone is bound to another account. One phone, one person.');
          const info = r.to_device_info;
          const hw = hardwareHash(deps.hash, info);
          const role = (await tx.query<{ role: string }>('select role from users where id = $1', [r.user_id])).rows[0]!.role;
          await assertPhoneFree(tx, hw, r.user_id, role);
          await revokeActiveDevice(tx, r.user_id, 'replaced by approved device switch', t);
          await tx.query(
            `insert into devices(user_id, public_key, fingerprint, platform, model, os_version, app_version, status, bound_at, hw_hash,
                                 hw_key_spki, attest_level, attest_patch, attested_at)
             values ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12, $13)`,
            [
              r.user_id,
              r.to_public_key,
              keyFingerprint(r.to_public_key),
              info.platform,
              info.model,
              info.osVersion,
              info.appVersion,
              t,
              hw,
              r.to_hw_key_spki,
              r.to_attest_level,
              r.to_attest_patch,
              r.to_hw_key_spki ? t : null,
            ],
          );
        } else {
          await revokeActiveDevice(tx, r.user_id, 'reset approved', t);
        }
      }
      await tx.query('update device_requests set status = $2, decided_by = $3, decided_at = $4 where id = $1', [id, b.decision === 'approve' ? 'approved' : 'denied', auth.userId, t]);
      // Tell the student how it went (they see it when they next open the app, on any phone).
      const approved = b.decision === 'approve';
      await insertNotifications(tx, auth.tenantId, [
        {
          userId: r.user_id,
          kind: 'device',
          title:
            r.kind === 'rebind'
              ? approved
                ? '✅ Phone switch approved'
                : '❌ Phone switch declined'
              : approved
                ? '✅ Phone unbound'
                : '❌ Unbind request declined',
          body:
            r.kind === 'rebind'
              ? approved
                ? 'Your new phone is now your Attendly phone. Sign in on it to continue.'
                : 'Your account stays on your current phone. Speak to your mentor if this is wrong.'
              : approved
                ? 'Your old phone was unbound. Sign in on your new phone to bind it.'
                : 'Your phone stays bound. Speak to your mentor if this is wrong.',
          data: { requestId: id },
        },
      ]);
      await staffAudit(tx, auth, `device_request.${b.decision}`, `request:${id}`, { kind: r.kind, user: r.user_id });
    });
    return { ok: true as const };
  });
}
