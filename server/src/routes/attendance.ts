import type { FastifyInstance } from 'fastify';
import {
  MAX_LOCATION_AGE_MS,
  MarkBody,
  REJECTION_CODES,
  attendancePercent,
  currentQrSeq,
  evaluateGeofence,
  isQrSeqFresh,
  parseQrToken,
  seqLabel,
  toB64url,
  verifyQrMac,
  type MarkResponse,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { isUniqueViolation, withTx } from '../db';
import { appendAudit } from '../lib/audit';
import { perDeviceKey, requireDevice, type AuthContext } from '../lib/auth';
import { ApiError, ScanRejection } from '../lib/errors';
import { signReceipt } from '../lib/receipts';
import { assignLectureNo } from '../lib/sessions';
import { courseStats, loadTenantTerm } from '../lib/stats';

/** Too many refused scans from one device in a short window looks like probing. */
const MAX_SUSPICIOUS_PER_10_MIN = 10;
const MAX_REJECTIONS_PER_10_MIN = 40;
/** Refusals caused by the institution, not the student — never count towards the throttle. */
const NOT_STUDENTS_FAULT = ['E-PAUSED', 'E-SESSION-CLOSED'];

/** Grace around a class's scheduled window for early/late scans. */
const WINDOW_GRACE_MS = 15 * 60_000;
/** A scan whose capture time is further than this from "now" is treated as an offline upload. */
const OFFLINE_THRESHOLD_MS = 90_000;
/** Offline scans must be uploaded within this long of being captured. */
const MAX_OFFLINE_AGE_MS = 24 * 60 * 60_000;

interface SessionRow {
  id: string;
  tenant_id: string;
  course_id: string;
  short_code: string;
  lecture_no: number | null;
  room: string | null;
  lat: number | null;
  lng: number | null;
  radius_m: number;
  rotation_s: number;
  qr_secret: Buffer;
  status: 'scheduled' | 'live' | 'closed' | 'cancelled';
  mode: 'qr' | 'manual';
  scheduled_start: Date;
  scheduled_end: Date;
  started_at: Date | null;
  ended_at: Date | null;
  course_code: string;
  course_title: string;
  course_kind: 'theory' | 'lab';
}

interface RecordRow {
  id: string;
  marked_at: Date;
  offline: boolean;
  revoked_at: Date | null;
  qr_seq: number;
  distance_m: number | null;
  receipt_signature: Buffer;
  server_key_id: string;
  device_fingerprint: string;
}

function toResponse(s: SessionRow, userId: string, r: RecordRow, alreadyMarked: boolean, before: number | null, after: number | null): MarkResponse {
  return {
    status: 'present',
    alreadyMarked,
    record: {
      id: r.id,
      sessionId: s.id,
      offline: r.offline,
      sessionCode: s.short_code,
      lectureNo: s.lecture_no,
      courseCode: s.course_code,
      courseTitle: s.course_title,
      kind: s.course_kind,
      markedAt: r.marked_at.toISOString(),
      qrSeq: r.qr_seq,
      distanceM: Math.round(r.distance_m ?? 0),
    },
    receipt: {
      userId,
      deviceFingerprint: r.device_fingerprint,
      serverKeyId: r.server_key_id,
      signature: toB64url(r.receipt_signature),
    },
    course: { before, after },
  };
}

const RECORD_COLUMNS = 'id, marked_at, offline, revoked_at, qr_seq, distance_m, receipt_signature, server_key_id, device_fingerprint';

export async function attendanceRoutes(app: FastifyInstance, deps: Deps) {
  /** The student's existing record for this session, if any, with their current course percentage. */
  async function existingReceipt(session: SessionRow, auth: AuthContext): Promise<MarkResponse | null> {
    const { rows } = await deps.db.query<RecordRow>(`select ${RECORD_COLUMNS} from attendance_records where session_id = $1 and user_id = $2`, [session.id, auth.userId]);
    if (!rows[0]) return null;
    if (rows[0].revoked_at) throw new ScanRejection('E-REVOKED');
    const term = await loadTenantTerm(deps.db, auth.tenantId);
    const [st] = await courseStats(deps.db, auth.userId, term, session.course_id);
    const pct = st ? attendancePercent(st.attended, st.held) : null;
    return toResponse(session, auth.userId, rows[0], true, pct, pct);
  }

  async function recordRejection(auth: AuthContext, sessionId: string | null, rej: ScanRejection) {
    const suspicious = REJECTION_CODES[rej.code].suspicious;
    try {
      await withTx(deps.db, async (tx) => {
        await tx.query(
          `insert into scan_rejections(tenant_id, session_id, user_id, device_id, code, suspicious, detail, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [auth.tenantId, sessionId, auth.userId, auth.deviceId, rej.code, suspicious, JSON.stringify(rej.data), new Date(deps.clock())],
        );
        await appendAudit(tx, {
          tenantId: auth.tenantId,
          actorType: 'user',
          actorId: auth.userId,
          action: 'mark.reject',
          subject: sessionId ? `session:${sessionId}` : null,
          data: { code: rej.code, device: auth.deviceFingerprint, ...rej.data },
        });
      });
    } catch (err) {
      // Failing to log a rejection must never turn into a false "present".
      deps.log.error({ err: (err as Error).message }, 'failed to record scan rejection');
    }
  }

  app.post('/v1/attendance/mark', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: perDeviceKey } } }, async (req, reply) => {
    const auth = await requireDevice(req, deps, ['student']);
    const body = MarkBody.parse(req.body);
    const now = deps.clock();
    let sessionId: string | null = null;

    try {
      const recent = await deps.db.query<{ n: number; suspicious: number }>(
        `select count(*) as n, count(*) filter (where suspicious) as suspicious from scan_rejections
          where device_id = $1 and created_at > $2 and code <> all($3::text[])`,
        [auth.deviceId, new Date(now - 10 * 60_000), NOT_STUDENTS_FAULT],
      );
      const r = recent.rows[0]!;
      if (r.n >= MAX_REJECTIONS_PER_10_MIN || r.suspicious >= MAX_SUSPICIOUS_PER_10_MIN) throw new ApiError(429, 'RATE_LIMITED', 'Too many failed scans. Wait a few minutes and try again.');

      const paused = await deps.db.query<{ enabled: boolean }>(`select enabled from system_flags where key = 'scans_paused'`);
      if (paused.rows[0]?.enabled) throw new ScanRejection('E-PAUSED');

      // 1. Token must be a well-formed, authentic QR for a session of *this* institution.
      const parsed = parseQrToken(body.qr);
      if (!parsed) throw new ScanRejection('E-QR-INVALID', 'The scanned code is not an Attendly session code.', { reason: 'malformed' });
      const { rows } = await deps.db.query<SessionRow>(
        `select s.*, coalesce(r.name, s.room) as room, c.code as course_code, c.title as course_title, c.kind as course_kind
           from class_sessions s join courses c on c.id = s.course_id left join rooms r on r.id = s.room_id where s.id = $1`,
        [parsed.sessionId],
      );
      const session = rows[0];
      if (!session || session.tenant_id !== auth.tenantId || !verifyQrMac(session.qr_secret, parsed))
        throw new ScanRejection('E-QR-INVALID', 'The scanned code failed its cryptographic check.', { reason: 'bad_mac' });
      sessionId = session.id;

      // 2. Idempotency: a retry after a lost response returns the original receipt.
      const existing = await existingReceipt(session, auth);
      if (existing) return existing;

      // 3. When was the code scanned? Offline scans carry their (server-corrected) capture time.
      const scannedAt = body.scannedAt ?? now;
      const offline = Math.abs(now - scannedAt) > OFFLINE_THRESHOLD_MS;
      if (scannedAt > now + OFFLINE_THRESHOLD_MS) throw new ScanRejection('E-GPS-STALE', 'This scan is dated in the future. Enable automatic date & time.', { scannedAt });
      if (offline && now - scannedAt > MAX_OFFLINE_AGE_MS)
        throw new ScanRejection('E-EXPIRED', 'Offline scans must be uploaded within 24 hours.', { ageMs: now - scannedAt, offline: true });

      // 4. Session state at the moment of scanning, and the roster.
      if (session.mode !== 'qr') throw new ScanRejection('E-SESSION-CLOSED', 'This class uses a paper/manual register.', { mode: session.mode });
      if (session.status === 'cancelled') throw new ScanRejection('E-SESSION-CLOSED', 'This class was cancelled.', { status: session.status });
      const opens = (session.started_at ?? session.scheduled_start).getTime() - WINDOW_GRACE_MS;
      const closes =
        session.status === 'live' ? Number.POSITIVE_INFINITY : (session.ended_at ?? session.scheduled_end).getTime() + (session.ended_at ? 60_000 : WINDOW_GRACE_MS);
      if (scannedAt < opens || scannedAt > closes) throw new ScanRejection('E-SESSION-CLOSED', undefined, { status: session.status });
      if (session.status === 'closed' && !offline) throw new ScanRejection('E-SESSION-CLOSED', undefined, { status: session.status });
      if (session.lat === null || session.lng === null)
        throw new ScanRejection('E-SESSION-CLOSED', 'Your instructor has not started this class yet.', { reason: 'no_location' });
      const enrolled = await deps.db.query('select 1 from enrollments where course_id = $1 and user_id = $2', [session.course_id, auth.userId]);
      if (enrolled.rowCount !== 1) throw new ScanRejection('E-NOT-ENROLLED', undefined, { course: session.course_code });

      // 5. Freshness of the rotating token relative to the scan moment.
      const cur = currentQrSeq(scannedAt, session.rotation_s);
      if (!isQrSeqFresh(parsed.seq, cur))
        throw new ScanRejection('E-EXPIRED', `Token ${seqLabel(parsed.seq)} expired — the live code was ${seqLabel(cur)}.`, { seq: parsed.seq, current: cur, offline });

      // 6. Location: genuine, fresh relative to the scan, precise and inside the geofence.
      const loc = body.location;
      if (loc.mocked) throw new ScanRejection('E-MOCK', 'The operating system flagged this location as coming from a mock-location provider.', { signal: 'os_mock_flag' });
      if (Math.abs(scannedAt - loc.capturedAt) > MAX_LOCATION_AGE_MS) throw new ScanRejection('E-GPS-STALE', undefined, { ageMs: scannedAt - loc.capturedAt });
      const geo = evaluateGeofence({ centerLat: session.lat, centerLng: session.lng, radiusM: session.radius_m, lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM });
      const where = session.room ?? 'the classroom';
      if (!geo.ok) {
        const distance = Math.round(geo.distanceM);
        const data = { distanceM: distance, accuracyM: loc.accuracyM, radiusM: session.radius_m, offline };
        if (geo.reason === 'suspicious') throw new ScanRejection('E-MOCK', `GPS reported ${loc.accuracyM}m accuracy, which real hardware never does.`, { ...data, signal: 'zero_accuracy' });
        if (geo.reason === 'imprecise') throw new ScanRejection('E-GPS-WEAK', `Your location is only accurate to ±${Math.round(loc.accuracyM)}m.`, data);
        throw new ScanRejection('E-GEO', `You're ${distance}m from ${where}. Sessions accept marks only inside the ${session.radius_m}m perimeter.`, data);
      }

      // 7. Record + sign the receipt atomically. A scheduled class goes live on its first valid scan
      //    (the teacher's phone may be showing the code offline).
      const term = await loadTenantTerm(deps.db, auth.tenantId);
      const [beforeStats] = await courseStats(deps.db, auth.userId, term, session.course_id);
      const before = beforeStats ? attendancePercent(beforeStats.attended, beforeStats.held) : null;
      // An unmarked live session is not yet "held" for this student; marking it adds one to both.
      const after = beforeStats ? attendancePercent(beforeStats.attended + 1, beforeStats.held + 1) : null;
      try {
        const record = await withTx(deps.db, async (tx) => {
          if (session.status === 'scheduled') {
            await tx.query(`update class_sessions set status = 'live', started_at = $2 where id = $1 and status = 'scheduled'`, [
              session.id,
              new Date(Math.min(scannedAt, now)),
            ]);
            await assignLectureNo(tx, session.id);
          }
          const markedAt = new Date(scannedAt);
          const recordId = (await tx.query<{ id: string }>('select gen_random_uuid() as id')).rows[0]!.id;
          const receipt = signReceipt(deps.signer, {
            recordId,
            sessionId: session.id,
            userId: auth.userId,
            markedAt,
            deviceFingerprint: auth.deviceFingerprint,
            qrSeq: parsed.seq,
          });
          const ins = await tx.query<RecordRow>(
            `insert into attendance_records(id, session_id, user_id, device_id, marked_at, qr_seq, lat, lng, accuracy_m, distance_m,
                                            device_signature, request_digest, receipt_signature, server_key_id, device_fingerprint, offline)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             returning ${RECORD_COLUMNS}`,
            [
              recordId,
              session.id,
              auth.userId,
              auth.deviceId,
              markedAt,
              parsed.seq,
              loc.lat,
              loc.lng,
              loc.accuracyM,
              geo.distanceM,
              auth.signature,
              auth.requestDigest,
              receipt,
              deps.signer.kid,
              auth.deviceFingerprint,
              offline,
            ],
          );
          await appendAudit(tx, {
            tenantId: auth.tenantId,
            actorType: 'user',
            actorId: auth.userId,
            action: offline ? 'mark.accept_offline' : 'mark.accept',
            subject: `session:${session.id}`,
            data: { record: recordId, seq: parsed.seq, device: auth.deviceFingerprint, distanceM: Math.round(geo.distanceM), ...(offline ? { lagMs: now - scannedAt } : {}) },
          });
          return ins.rows[0]!;
        });
        return toResponse(session, auth.userId, record, false, before, after);
      } catch (err) {
        // Two concurrent submissions: the loser returns the winner's receipt.
        if (!isUniqueViolation(err, 'attendance_records_session_id_user_id_key')) throw err;
        const winner = await existingReceipt(session, auth);
        if (!winner) throw err;
        return winner;
      }
    } catch (err) {
      if (err instanceof ScanRejection) {
        await recordRejection(auth, sessionId, err);
        return reply.code(422).send(err.toBody());
      }
      throw err;
    }
  });
}
