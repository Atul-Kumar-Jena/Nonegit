import type { FastifyInstance } from 'fastify';
import {
  ResetRequestBody,
  attendancePercent,
  sessionsNeededToReach,
  sessionsSafeToMiss,
  standing,
  type DashboardResponse,
  type DeviceRequestResponse,
  type ProfileResponse,
  type SubjectsResponse,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { isUniqueViolation, withTx } from '../db';
import { appendAudit } from '../lib/audit';
import { perDeviceKey, requireDevice, type AuthContext } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { courseStats, loadTenantTerm } from '../lib/stats';
import { loadDevice, loadUser, toDeviceSummary, toUserSummary } from '../lib/users';

const STUDENT = ['student'] as const;
/** Sentinel for "cannot be reached / unlimited" in needToReach and safeToMiss. */
export const UNREACHABLE = 10_000;

async function userAndDevice(deps: Deps, auth: AuthContext) {
  const [user, device] = await Promise.all([loadUser(deps.db, auth.userId), loadDevice(deps.db, auth.deviceId)]);
  if (!user || !device) throw new ApiError(401, 'UNAUTHENTICATED');
  return { user: toUserSummary(user), device: toDeviceSummary(device) };
}

export async function studentRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/v1/me/dashboard', async (req): Promise<DashboardResponse> => {
    const auth = await requireDevice(req, deps, STUDENT);
    const term = await loadTenantTerm(deps.db, auth.tenantId);
    const [{ user, device }, stats, today] = await Promise.all([
      userAndDevice(deps, auth),
      courseStats(deps.db, auth.userId, term),
      deps.db.query<{
        id: string;
        code: string;
        title: string;
        room: string | null;
        status: 'scheduled' | 'live' | 'closed' | 'cancelled';
        scheduled_start: Date;
        scheduled_end: Date;
        marked: boolean;
      }>(
        `select s.id, c.code, c.title, s.room, s.status, s.scheduled_start, s.scheduled_end,
                exists(select 1 from attendance_records a where a.session_id = s.id and a.user_id = $1) as marked
           from class_sessions s
           join courses c on c.id = s.course_id
           join enrollments e on e.course_id = c.id and e.user_id = $1
          where (s.scheduled_start at time zone $2)::date = (now() at time zone $2)::date
             or s.status = 'live'
          order by (s.status = 'live') desc, s.scheduled_start`,
        [auth.userId, term.timezone],
      ),
    ]);

    let attended = 0;
    let held = 0;
    let attendedBefore = 0;
    let heldBefore = 0;
    for (const s of stats) {
      attended += s.attended;
      held += s.held;
      attendedBefore += s.attended_before_week;
      heldBefore += s.held_before_week;
    }
    const percent = attendancePercent(attended, held);
    const before = attendancePercent(attendedBefore, heldBefore);
    const weekDelta = percent !== null && before !== null && held !== heldBefore ? Math.round((percent - before) * 10) / 10 : null;

    return {
      user,
      device,
      term: { name: term.term_name, attended, held, percent, weekDelta, minPercent: term.min_attendance },
      today: today.rows.map((r) => ({
        sessionId: r.id,
        courseCode: r.code,
        courseTitle: r.title,
        room: r.room,
        status: r.status,
        scheduledStart: r.scheduled_start.toISOString(),
        scheduledEnd: r.scheduled_end.toISOString(),
        marked: r.marked,
      })),
      timezone: term.timezone,
      serverTime: deps.clock(),
    };
  });

  app.get('/v1/me/subjects', async (req): Promise<SubjectsResponse> => {
    const auth = await requireDevice(req, deps, STUDENT);
    const term = await loadTenantTerm(deps.db, auth.tenantId);
    const stats = await courseStats(deps.db, auth.userId, term);
    const min = term.min_attendance;
    const termStartMs = Date.parse(`${term.term_start}T00:00:00Z`);
    const termWeek = Math.max(1, Math.floor((deps.clock() - termStartMs) / (7 * 86_400_000)) + 1);
    return {
      termName: term.term_name,
      termWeek,
      minPercent: min,
      subjects: stats.map((s) => ({
        courseId: s.course_id,
        code: s.code,
        title: s.title,
        kind: s.kind,
        instructor: s.instructor,
        attended: s.attended,
        held: s.held,
        percent: attendancePercent(s.attended, s.held),
        standing: standing(s.attended, s.held, min),
        // Both helpers can return Infinity (e.g. a 100% rule); JSON has no Infinity, so cap them.
        needToReach: Math.min(sessionsNeededToReach(s.attended, s.held, min), UNREACHABLE),
        safeToMiss: Math.min(sessionsSafeToMiss(s.attended, s.held, min), UNREACHABLE),
      })),
    };
  });

  app.get('/v1/me/profile', async (req): Promise<ProfileResponse> => {
    const auth = await requireDevice(req, deps, STUDENT);
    const term = await loadTenantTerm(deps.db, auth.tenantId);
    const [{ user, device }, last, resets] = await Promise.all([
      userAndDevice(deps, auth),
      deps.db.query<{ at: Date | null }>('select max(marked_at) as at from attendance_records where user_id = $1', [auth.userId]),
      deps.db.query<{ id: string; status: string; reason: string; created_at: Date }>(
        `select id, status, reason, created_at from device_requests
          where user_id = $1 and kind = 'reset' and created_at >= ($2::date::timestamp at time zone $3)
          order by created_at desc`,
        [auth.userId, term.term_start, term.timezone],
      ),
    ]);
    const pending = resets.rows.find((r) => r.status === 'pending');
    return {
      user,
      device,
      lastScanAt: last.rows[0]?.at ? last.rows[0].at.toISOString() : null,
      resetRequests: {
        used: resets.rows.filter((r) => r.status !== 'cancelled').length,
        limit: term.device_reset_limit,
        pending: pending ? { id: pending.id, createdAt: pending.created_at.toISOString(), reason: pending.reason } : null,
      },
    };
  });

  /** "I'm changing phones" — asks an admin to unbind this device. */
  app.post('/v1/me/device-reset', { config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: perDeviceKey } } }, async (req): Promise<DeviceRequestResponse> => {
    const auth = await requireDevice(req, deps, STUDENT);
    const body = ResetRequestBody.parse(req.body);
    const term = await loadTenantTerm(deps.db, auth.tenantId);
    try {
      return await withTx(deps.db, async (tx) => {
        await tx.query('select id from users where id = $1 for update', [auth.userId]);
        const { rows } = await tx.query<{ n: number; pending: number }>(
          `select count(*) filter (where status <> 'cancelled') as n, count(*) filter (where status = 'pending') as pending
             from device_requests where user_id = $1 and kind = 'reset' and created_at >= ($2::date::timestamp at time zone $3)`,
          [auth.userId, term.term_start, term.timezone],
        );
        if (rows[0]!.pending > 0) throw new ApiError(409, 'CONFLICT', 'You already have a pending reset request.');
        if (rows[0]!.n >= term.device_reset_limit) throw new ApiError(403, 'LIMIT_REACHED', `You can request at most ${term.device_reset_limit} device resets per term.`);
        const ins = await tx.query<{ id: string }>(
          `insert into device_requests(user_id, kind, from_device_id, reason) values ($1, 'reset', $2, $3) returning id`,
          [auth.userId, auth.deviceId, body.reason],
        );
        await appendAudit(tx, {
          tenantId: auth.tenantId,
          actorType: 'user',
          actorId: auth.userId,
          action: 'device.reset_request',
          subject: `request:${ins.rows[0]!.id}`,
          data: { device: auth.deviceFingerprint },
        });
        return { requestId: ins.rows[0]!.id, status: 'pending' as const };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'device_requests_one_pending')) throw new ApiError(409, 'CONFLICT', 'You already have a pending device request.');
      throw err;
    }
  });
}
