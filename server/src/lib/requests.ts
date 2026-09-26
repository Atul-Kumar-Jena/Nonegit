/**
 * Requests about one class.
 *
 *  cover:   an admin, or the class's own teacher, asks another teacher to take it.
 *           The timetable does not change until that teacher accepts; then the change is
 *           published exactly like any other adjustment (clash checks, students notified,
 *           with the note for students). The requester hears back either way.
 *  student: a student asks the teacher of a class something (move it, an extra class…).
 *           The teacher replies; any actual change goes through the normal adjust flow.
 */
import type { PoolClient } from 'pg';
import {
  STUDENT_TOPIC_LABELS,
  type ChangeRequest,
  type CoverRequestBody,
  type CoverResponse,
  type DecisionResponse,
  type DraftOp,
  type PlannerConflict,
  type OpError,
  type ReplyBody,
  type StudentRequestBody,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import type { Queryable } from '../db';
import { loadInstitution, staffAudit } from '../routes/staff-admin';
import { isAdmin, loadSessionFor } from './access';
import type { AuthContext } from './auth';
import { appendAudit } from './audit';
import { ApiError } from './errors';
import { tenantFlag } from './flags';
import { fmtWhen, insertNotifications } from './notify';
import { publishOps } from './planner-server';

interface RequestRow {
  id: string;
  kind: 'cover' | 'student';
  topic: ChangeRequest['topic'];
  status: ChangeRequest['status'];
  created_at: Date;
  decided_at: Date | null;
  note_to_teacher: string | null;
  note_to_students: string | null;
  reply: string | null;
  requested_by: string;
  from_name: string;
  from_role: ChangeRequest['from']['role'];
  from_roll: string | null;
  target_id: string;
  to_name: string;
  session_id: string;
  course_id: string;
  course_code: string;
  course_title: string;
  scheduled_start: Date;
  scheduled_end: Date;
  room: string | null;
  session_status: string;
  teacher_name: string | null;
  tenant_id: string;
}

const SELECT = `
  select r.id, r.kind, r.topic, r.status, r.created_at, r.decided_at, r.note_to_teacher, r.note_to_students, r.reply,
         r.requested_by, f.full_name as from_name, f.role as from_role, f.roll_no as from_roll,
         r.target_id, t.full_name as to_name, r.tenant_id,
         s.id as session_id, s.course_id, c.code as course_code, c.title as course_title, s.scheduled_start, s.scheduled_end,
         s.room, s.status as session_status, coalesce(sub.full_name, ins.full_name) as teacher_name
    from change_requests r
    join users f on f.id = r.requested_by
    join users t on t.id = r.target_id
    join class_sessions s on s.id = r.session_id
    join courses c on c.id = s.course_id
    left join users sub on sub.id = s.substitute_id
    left join users ins on ins.id = c.instructor_id`;

function toRequest(r: RequestRow): ChangeRequest {
  return {
    id: r.id,
    kind: r.kind,
    topic: r.topic,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
    noteToTeacher: r.note_to_teacher,
    noteToStudents: r.note_to_students,
    reply: r.reply,
    from: { id: r.requested_by, name: r.from_name, role: r.from_role, rollNo: r.from_roll },
    to: { id: r.target_id, name: r.to_name },
    session: {
      id: r.session_id,
      courseId: r.course_id,
      courseCode: r.course_code,
      courseTitle: r.course_title,
      start: r.scheduled_start.toISOString(),
      end: r.scheduled_end.toISOString(),
      room: r.room,
      status: r.session_status,
      teacher: r.teacher_name,
    },
  };
}

async function loadRequest(db: Queryable, id: string, tenantId: string, forUpdate = false): Promise<RequestRow> {
  const { rows } = await db.query<RequestRow>(`${SELECT} where r.id = $1 and r.tenant_id = $2${forUpdate ? ' for update of r' : ''}`, [id, tenantId]);
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
  return rows[0];
}

/** Pending requests plus the last 30 days of answered ones, newest first. */
export async function listRequests(db: Queryable, auth: AuthContext, nowMs: number): Promise<{ incoming: ChangeRequest[]; outgoing: ChangeRequest[] }> {
  const since = new Date(nowMs - 30 * 86_400_000);
  const q = async (col: 'target_id' | 'requested_by') =>
    (
      await db.query<RequestRow>(
        `${SELECT} where r.tenant_id = $1 and r.${col} = $2 and (r.status = 'pending' or r.created_at >= $3)
          order by (r.status = 'pending') desc, r.created_at desc limit 100`,
        [auth.tenantId, auth.userId, since],
      )
    ).rows.map(toRequest);
  return { incoming: await q('target_id'), outgoing: await q('requested_by') };
}

/** A class that can still be handed over / asked about: not cancelled, not over. */
function assertOpen(s: { status: string; scheduled_end: Date }, nowMs: number) {
  if (s.status === 'cancelled') throw new ApiError(409, 'CONFLICT', 'This class is cancelled.');
  if (s.status === 'closed' || s.scheduled_end.getTime() <= nowMs) throw new ApiError(409, 'CONFLICT', 'This class is already over.');
}

const blocked = (conflicts: PlannerConflict[], errors: OpError[], acceptWarnings: boolean) =>
  errors.length > 0 || conflicts.some((c) => c.severity === 'error') || (conflicts.length > 0 && !acceptWarnings);

async function whenText(db: Queryable, tenantId: string, start: Date, end: Date): Promise<string> {
  const tz = (await loadInstitution(db, tenantId)).timezone;
  const endHm = fmtWhen(end, tz).split(', ')[1] ?? '';
  return `${fmtWhen(start, tz)}–${endHm}`;
}

/**
 * Ask a teacher to take a class. Taking it yourself (or giving it back to the course's
 * own teacher) needs nobody's approval and is applied at once.
 */
export async function createCoverRequest(tx: PoolClient, deps: Deps, auth: AuthContext, body: CoverRequestBody): Promise<CoverResponse> {
  // Hierarchy: only admins (principal / HOD) hand classes out; teachers answer.
  if (!isAdmin(auth)) throw new ApiError(403, 'FORBIDDEN', 'Only an admin (principal or HOD) can give a class to another teacher. Teachers accept or decline requests.');
  const s = await loadSessionFor(tx, auth, body.sessionId, true);
  assertOpen(s, deps.clock());
  const target = (
    await tx.query<{ id: string; full_name: string; role: string; status: string }>(
      `select id, full_name, role, status from users where id = $1 and tenant_id = $2`,
      [body.teacherId, auth.tenantId],
    )
  ).rows[0];
  if (!target || !['teacher', 'admin'].includes(target.role) || target.status !== 'active') throw new ApiError(400, 'BAD_REQUEST', 'Pick an active teacher.');
  if ((s.substitute_id ?? s.instructor_id) === target.id) throw new ApiError(409, 'CONFLICT', `${target.full_name} already takes this class.`);

  const op: DraftOp = { op: 'substitute', sessionId: s.id, teacherId: target.id, noteToStudents: body.noteToStudents || undefined };
  // Same checks as publishing: is the teacher (or anything else) clashing at that time?
  const check = await publishOps(tx, deps, auth, [op], { dryRun: true, acceptWarnings: body.acceptWarnings });
  if (blocked(check.conflicts, check.errors, body.acceptWarnings)) return { status: 'refused', request: null, conflicts: check.conflicts, errors: check.errors, notified: 0 };

  // No one to ask: you take it yourself, or it goes back to its own teacher.
  if (target.id === auth.userId || target.id === s.instructor_id) {
    const r = await publishOps(tx, deps, auth, [op], { acceptWarnings: true, note: body.noteToStudents ?? null });
    return { status: 'applied', request: null, conflicts: r.conflicts, errors: r.errors, notified: r.notified };
  }

  const now = new Date(deps.clock());
  // A newer request replaces an older one for the same class (its teacher is told).
  const prev = await tx.query<{ id: string; target_id: string }>(
    `update change_requests set status = 'cancelled', decided_at = $2, decided_by = $3
      where session_id = $1 and kind = 'cover' and status = 'pending' returning id, target_id`,
    [s.id, now, auth.userId],
  );
  const course = (await tx.query<{ code: string; title: string }>('select code, title from courses where id = $1', [s.course_id])).rows[0]!;
  const when = await whenText(tx, auth.tenantId, s.scheduled_start, s.scheduled_end);
  const me = (await tx.query<{ full_name: string }>('select full_name from users where id = $1', [auth.userId])).rows[0]!.full_name;
  const room = (await tx.query<{ room: string | null }>('select room from class_sessions where id = $1', [s.id])).rows[0]!.room;
  for (const p of prev.rows)
    if (p.target_id !== target.id)
      await insertNotifications(tx, auth.tenantId, [
        { userId: p.target_id, kind: 'request', title: `Request withdrawn · ${course.code}`, body: `${me} no longer needs you for ${course.code} on ${when}.`, data: { requestId: p.id, sessionId: s.id } },
      ]);

  const { rows } = await tx.query<{ id: string }>(
    `insert into change_requests(tenant_id, kind, topic, session_id, requested_by, target_id, note_to_teacher, note_to_students, created_at)
     values ($1, 'cover', 'cover', $2, $3, $4, $5, $6, $7) returning id`,
    [auth.tenantId, s.id, auth.userId, target.id, body.noteToTeacher || null, body.noteToStudents || null, now],
  );
  const id = rows[0]!.id;
  await insertNotifications(tx, auth.tenantId, [
    {
      userId: target.id,
      kind: 'request',
      title: `Can you take ${course.code}?`,
      body: [`${me} asks you to take ${course.code} · ${course.title}`, `${when}${room ? ` · ${room}` : ''}`, body.noteToTeacher ? `“${body.noteToTeacher}”` : null, 'Open Attendly Institute to accept or decline.']
        .filter(Boolean)
        .join('\n'),
      data: { requestId: id, sessionId: s.id },
    },
  ]);
  await staffAudit(tx, auth, 'cover.request', `request:${id}`, { sessionId: s.id, teacher: target.id, replaced: prev.rows.map((p) => p.id) });
  return { status: 'sent', request: toRequest(await loadRequest(tx, id, auth.tenantId)), conflicts: check.conflicts, errors: [], notified: 1 };
}

/** The asked teacher says yes: the class becomes theirs and its students are told. */
export async function acceptRequest(tx: PoolClient, deps: Deps, auth: AuthContext, id: string, body: ReplyBody): Promise<DecisionResponse> {
  const r = await loadRequest(tx, id, auth.tenantId, true);
  if (r.target_id !== auth.userId) throw new ApiError(403, 'FORBIDDEN', 'Only the teacher who was asked can answer this.');
  if (r.status !== 'pending') throw new ApiError(409, 'CONFLICT', `This request was already ${r.status}.`);
  const now = new Date(deps.clock());
  const decide = async (status: 'accepted' | 'expired') =>
    tx.query(`update change_requests set status = $2, reply = $3, decided_at = $4, decided_by = $5 where id = $1`, [id, status, body.reply || null, now, auth.userId]);

  let conflicts: PlannerConflict[] = [];
  let notified = 0;
  if (r.kind === 'cover') {
    if (r.session_status === 'cancelled' || r.session_status === 'closed' || r.scheduled_end.getTime() <= now.getTime()) {
      await decide('expired');
      throw new ApiError(409, 'CONFLICT', 'This class is cancelled or already over, so the request has expired.');
    }
    // Publish with the requester's authority: they are the one who may reorganise this class.
    const requester = (await tx.query<{ role: AuthContext['role']; status: string }>('select role, status from users where id = $1', [r.requested_by])).rows[0];
    if (!requester || requester.status !== 'active') {
      await decide('expired');
      throw new ApiError(409, 'CONFLICT', 'The person who asked no longer has access, so the request has expired.');
    }
    const asRequester: AuthContext = { ...auth, userId: r.requested_by, role: requester.role };
    const op: DraftOp = { op: 'substitute', sessionId: r.session_id, teacherId: auth.userId, noteToStudents: r.note_to_students ?? undefined };
    const res = await publishOps(tx, deps, asRequester, [op], { acceptWarnings: body.acceptWarnings, note: r.note_to_students, skipNotifyUserId: auth.userId });
    if (!res.published) return { request: toRequest(r), conflicts: res.conflicts, errors: res.errors, notified: 0 };
    conflicts = res.conflicts;
    notified = res.notified;
  }
  await decide('accepted');
  const when = await whenText(tx, auth.tenantId, r.scheduled_start, r.scheduled_end);
  const me = (await tx.query<{ full_name: string }>('select full_name from users where id = $1', [auth.userId])).rows[0]!.full_name;
  await insertNotifications(tx, auth.tenantId, [
    {
      userId: r.requested_by,
      kind: 'request',
      title: r.kind === 'cover' ? `${me} will take ${r.course_code}` : `${me} replied · ${r.course_code}`,
      body: [
        r.kind === 'cover' ? `Accepted: ${r.course_code} on ${when}. The students have been told.` : `Yes to “${STUDENT_TOPIC_LABELS[r.topic as keyof typeof STUDENT_TOPIC_LABELS]}” for ${r.course_code} on ${when}.`,
        body.reply ? `“${body.reply}”` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      data: { requestId: id, sessionId: r.session_id },
    },
  ]);
  await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: `${r.kind}.accept`, subject: `request:${id}`, data: { sessionId: r.session_id } });
  return { request: toRequest(await loadRequest(tx, id, auth.tenantId)), conflicts, errors: [], notified: notified + 1 };
}

export async function declineRequest(tx: PoolClient, deps: Deps, auth: AuthContext, id: string, body: ReplyBody): Promise<DecisionResponse> {
  const r = await loadRequest(tx, id, auth.tenantId, true);
  if (r.target_id !== auth.userId) throw new ApiError(403, 'FORBIDDEN', 'Only the teacher who was asked can answer this.');
  if (r.status !== 'pending') throw new ApiError(409, 'CONFLICT', `This request was already ${r.status}.`);
  const now = new Date(deps.clock());
  await tx.query(`update change_requests set status = 'declined', reply = $2, decided_at = $3, decided_by = $4 where id = $1`, [id, body.reply || null, now, auth.userId]);
  const when = await whenText(tx, auth.tenantId, r.scheduled_start, r.scheduled_end);
  const me = (await tx.query<{ full_name: string }>('select full_name from users where id = $1', [auth.userId])).rows[0]!.full_name;
  await insertNotifications(tx, auth.tenantId, [
    {
      userId: r.requested_by,
      kind: 'request',
      title: r.kind === 'cover' ? `${me} can’t take ${r.course_code}` : `${me} replied · ${r.course_code}`,
      body: [
        r.kind === 'cover' ? `Declined: ${r.course_code} on ${when}. Nothing changed — ask someone else.` : `No to “${STUDENT_TOPIC_LABELS[r.topic as keyof typeof STUDENT_TOPIC_LABELS]}” for ${r.course_code} on ${when}.`,
        body.reply ? `“${body.reply}”` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      data: { requestId: id, sessionId: r.session_id },
    },
  ]);
  await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: `${r.kind}.decline`, subject: `request:${id}` });
  return { request: toRequest(await loadRequest(tx, id, auth.tenantId)), conflicts: [], errors: [], notified: 1 };
}

/** The person who asked (or an admin, for cover requests) takes it back. */
export async function cancelRequest(tx: PoolClient, deps: Deps, auth: AuthContext, id: string): Promise<ChangeRequest> {
  const r = await loadRequest(tx, id, auth.tenantId, true);
  if (r.requested_by !== auth.userId && !(r.kind === 'cover' && isAdmin(auth))) throw new ApiError(403, 'FORBIDDEN', 'Only the person who asked can withdraw this.');
  if (r.status !== 'pending') throw new ApiError(409, 'CONFLICT', `This request was already ${r.status}.`);
  await tx.query(`update change_requests set status = 'cancelled', decided_at = $2, decided_by = $3 where id = $1`, [id, new Date(deps.clock()), auth.userId]);
  const when = await whenText(tx, auth.tenantId, r.scheduled_start, r.scheduled_end);
  await insertNotifications(tx, auth.tenantId, [
    { userId: r.target_id, kind: 'request', title: `Request withdrawn · ${r.course_code}`, body: `${r.from_name} withdrew the request about ${r.course_code} on ${when}.`, data: { requestId: id, sessionId: r.session_id } },
  ]);
  await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: `${r.kind}.cancel`, subject: `request:${id}` });
  return toRequest(await loadRequest(tx, id, auth.tenantId));
}

const MAX_OPEN_STUDENT_REQUESTS = 5;

/** A student asks the teacher of one of their classes. */
export async function createStudentRequest(tx: PoolClient, deps: Deps, auth: AuthContext, body: StudentRequestBody): Promise<ChangeRequest> {
  if (!(await tenantFlag(tx, auth.tenantId, 'student_requests'))) throw new ApiError(403, 'FORBIDDEN', 'Your institution has turned off requests to teachers.');
  const { rows } = await tx.query<{ id: string; status: string; scheduled_start: Date; scheduled_end: Date; teacher: string | null; code: string; title: string }>(
    `select s.id, s.status, s.scheduled_start, s.scheduled_end, coalesce(s.substitute_id, c.instructor_id) as teacher, c.code, c.title
       from class_sessions s join courses c on c.id = s.course_id
       join enrollments e on e.course_id = c.id and e.user_id = $2
      where s.id = $1 and s.tenant_id = $3`,
    [body.sessionId, auth.userId, auth.tenantId],
  );
  const s = rows[0];
  if (!s) throw new ApiError(404, 'NOT_FOUND', 'Class not found.');
  if (s.status === 'closed' || s.scheduled_end.getTime() <= deps.clock()) throw new ApiError(409, 'CONFLICT', 'This class is already over.');
  if (!s.teacher) throw new ApiError(409, 'CONFLICT', 'This class has no teacher assigned yet.');
  const open = await tx.query<{ n: number }>(`select count(*)::int as n from change_requests where requested_by = $1 and status = 'pending'`, [auth.userId]);
  if (open.rows[0]!.n >= MAX_OPEN_STUDENT_REQUESTS) throw new ApiError(429, 'RATE_LIMITED', `You already have ${MAX_OPEN_STUDENT_REQUESTS} open requests. Wait for replies (or withdraw one) first.`);
  const dup = await tx.query('select 1 from change_requests where session_id = $1 and requested_by = $2 and status = $3', [s.id, auth.userId, 'pending']);
  if (dup.rowCount) throw new ApiError(409, 'CONFLICT', 'You already asked about this class. Wait for the reply, or withdraw it first.');
  const now = new Date(deps.clock());
  const ins = await tx.query<{ id: string }>(
    `insert into change_requests(tenant_id, kind, topic, session_id, requested_by, target_id, note_to_teacher, created_at)
     values ($1, 'student', $2, $3, $4, $5, $6, $7) returning id`,
    [auth.tenantId, body.topic, s.id, auth.userId, s.teacher, body.note, now],
  );
  const id = ins.rows[0]!.id;
  const me = (await tx.query<{ full_name: string; roll_no: string | null }>('select full_name, roll_no from users where id = $1', [auth.userId])).rows[0]!;
  const when = await whenText(tx, auth.tenantId, s.scheduled_start, s.scheduled_end);
  await insertNotifications(tx, auth.tenantId, [
    {
      userId: s.teacher,
      kind: 'request',
      title: `${me.full_name} · ${s.code}: ${STUDENT_TOPIC_LABELS[body.topic]}`,
      body: `${s.code} on ${when}${me.roll_no ? ` · ${me.roll_no}` : ''}\n“${body.note}”`,
      data: { requestId: id, sessionId: s.id },
    },
  ]);
  await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'student.request', subject: `request:${id}`, data: { sessionId: s.id, topic: body.topic } });
  return toRequest(await loadRequest(tx, id, auth.tenantId));
}

/**
 * Substitutions in a planner draft or an adjustment are *requests* unless you take the class
 * yourself or give it back to the course's own teacher: nobody gets a class without saying yes.
 */
export async function needsApproval(db: Queryable, auth: AuthContext, op: DraftOp): Promise<boolean> {
  if (op.op !== 'substitute' || !op.teacherId || op.teacherId === auth.userId) return false;
  const { rows } = await db.query<{ instructor_id: string | null }>(
    'select c.instructor_id from class_sessions s join courses c on c.id = s.course_id where s.id = $1 and s.tenant_id = $2',
    [op.sessionId, auth.tenantId],
  );
  return rows[0]?.instructor_id !== op.teacherId;
}
