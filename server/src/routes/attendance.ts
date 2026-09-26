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
  receiptSigningString,
  toB64url,
  verifyQrMac,
  type MarkResponse,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { isUniqueViolation, withTx } from '../db';
import { appendAudit } from '../lib/audit';
import { requireDevice, type AuthContext } from '../lib/auth';
import { ApiError, ScanRejection } from '../lib/errors';
import { courseStats, loadTenantTerm } from '../lib/stats';

/** Too many refused scans from one device in a short window looks like probing. */
const MAX_SUSPICIOUS_PER_10_MIN = 10;
const MAX_REJECTIONS_PER_10_MIN = 40;

interface SessionRow {
  id: string;
  tenant_id: string;
  course_id: string;
  short_code: string;
  lecture_no: number | null;
  room: string | null;
  lat: number;
  lng: number;
  radius_m: number;
  rotation_s: number;
  qr_secret: Buffer;
  status: 'scheduled' | 'live' | 'closed' | 'cancelled';
  started_at: Date | null;
  course_code: string;
  course_title: string;
  course_kind: 'theory' | 'lab';
}

interface RecordRow {
  id: string;
  marked_at: Date;
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

export async function attendanceRoutes(app: FastifyInstance, deps: Deps) {
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

  app.post('/v1/attendance/mark', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await requireDevice(req, deps, ['student']);
    const body = MarkBody.parse(req.body);
    const now = deps.clock();
    let sessionId: string | null = null;

    try {
      const recent = await deps.db.query<{ n: number; suspicious: number }>(
        `select count(*) as n, count(*) filter (where suspicious) as suspicious from scan_rejections where device_id = $1 and created_at > $2`,
        [auth.deviceId, new Date(now - 10 * 60_000)],
      );
      const r = recent.rows[0]!;
      if (r.n >= MAX_REJECTIONS_PER_10_MIN || r.suspicious >= MAX_SUSPICIOUS_PER_10_MIN) throw new ApiError(429, 'RATE_LIMITED', 'Too many failed scans. Wait a few minutes and try again.');

      const paused = await deps.db.query<{ enabled: boolean }>(`select enabled from system_flags where key = 'scans_paused'`);
      if (paused.rows[0]?.enabled) throw new ScanRejection('E-PAUSED');

      // 1. Token must be a well-formed, authentic QR for a session of *this* institution.
      const parsed = parseQrToken(body.qr);
      if (!parsed) throw new ScanRejection('E-QR-INVALID', 'The scanned code is not an Attendly session code.', { reason: 'malformed' });
      const { rows } = await deps.db.query<SessionRow>(
        `select s.*, c.code as course_code, c.title as course_title, c.kind as course_kind
           from class_sessions s join courses c on c.id = s.course_id where s.id = $1`,
        [parsed.sessionId],
      );
      const session = rows[0];
      if (!session || session.tenant_id !== auth.tenantId || !verifyQrMac(session.qr_secret, parsed))
        throw new ScanRejection('E-QR-INVALID', 'The scanned code failed its cryptographic check.', { reason: 'bad_mac' });
      sessionId = session.id;

      // 2. Idempotency: a retry after a lost response returns the original receipt.
      const existing = await deps.db.query<RecordRow>(
        `select id, marked_at, qr_seq, distance_m, receipt_signature, server_key_id, device_fingerprint
           from attendance_records where session_id = $1 and user_id = $2`,
        [session.id, auth.userId],
      );
      if (existing.rows[0]) {
        const term = await loadTenantTerm(deps.db, auth.tenantId);
        const [st] = await courseStats(deps.db, auth.userId, term, session.course_id);
        const pct = st ? attendancePercent(st.attended, st.held) : null;
        return toResponse(session, auth.userId, existing.rows[0], true, pct, pct);
      }

      // 3. Session state and roster.
      if (session.status !== 'live' || !session.started_at) throw new ScanRejection('E-SESSION-CLOSED', undefined, { status: session.status });
      const enrolled = await deps.db.query('select 1 from enrollments where course_id = $1 and user_id = $2', [session.course_id, auth.userId]);
      if (enrolled.rowCount !== 1) throw new ScanRejection('E-NOT-ENROLLED', undefined, { course: session.course_code });

      // 4. Freshness of the rotating token.
      const cur = currentQrSeq(session.started_at.getTime(), now, session.rotation_s);
      if (!isQrSeqFresh(parsed.seq, cur))
        throw new ScanRejection('E-EXPIRED', `Token #${String(parsed.seq).padStart(4, '0')} expired — the live code is now #${String(cur).padStart(4, '0')}.`, {
          seq: parsed.seq,
          current: cur,
        });

      // 5. Location: genuine, fresh, precise and inside the geofence.
      const loc = body.location;
      if (loc.mocked) throw new ScanRejection('E-MOCK', 'The operating system flagged this location as coming from a mock-location provider.', { signal: 'os_mock_flag' });
      if (Math.abs(now - loc.capturedAt) > MAX_LOCATION_AGE_MS)
        throw new ScanRejection('E-GPS-STALE', undefined, { ageMs: now - loc.capturedAt });
      const geo = evaluateGeofence({ centerLat: session.lat, centerLng: session.lng, radiusM: session.radius_m, lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM });
      const where = session.room ?? 'the classroom';
      if (!geo.ok) {
        const distance = Math.round(geo.distanceM);
        const data = { distanceM: distance, accuracyM: loc.accuracyM, radiusM: session.radius_m };
        if (geo.reason === 'suspicious') throw new ScanRejection('E-MOCK', `GPS reported ${loc.accuracyM}m accuracy, which real hardware never does.`, { ...data, signal: 'zero_accuracy' });
        if (geo.reason === 'imprecise') throw new ScanRejection('E-GPS-WEAK', `Your location is only accurate to ±${Math.round(loc.accuracyM)}m.`, data);
        throw new ScanRejection('E-GEO', `You're ${distance}m from ${where}. Sessions accept marks only inside the ${session.radius_m}m perimeter.`, data);
      }

      // 6. Record + sign the receipt atomically.
      const term = await loadTenantTerm(deps.db, auth.tenantId);
      const [beforeStats] = await courseStats(deps.db, auth.userId, term, session.course_id);
      const before = beforeStats ? attendancePercent(beforeStats.attended, beforeStats.held) : null;
      try {
        const record = await withTx(deps.db, async (tx) => {
          const markedAt = new Date(now);
          const recordId = (await tx.query<{ id: string }>('select gen_random_uuid() as id')).rows[0]!.id;
          const receipt = deps.signer.sign(
            receiptSigningString({
              recordId,
              sessionId: session.id,
              userId: auth.userId,
              markedAt: markedAt.toISOString(),
              deviceFingerprint: auth.deviceFingerprint,
              qrSeq: parsed.seq,
              serverKeyId: deps.signer.kid,
            }),
          );
          const ins = await tx.query<RecordRow>(
            `insert into attendance_records(id, session_id, user_id, device_id, marked_at, qr_seq, lat, lng, accuracy_m, distance_m,
                                            device_signature, request_digest, receipt_signature, server_key_id, device_fingerprint)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             returning id, marked_at, qr_seq, distance_m, receipt_signature, server_key_id, device_fingerprint`,
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
              Buffer.from(receipt),
              deps.signer.kid,
              auth.deviceFingerprint,
            ],
          );
          await appendAudit(tx, {
            tenantId: auth.tenantId,
            actorType: 'user',
            actorId: auth.userId,
            action: 'mark.accept',
            subject: `session:${session.id}`,
            data: { record: recordId, seq: parsed.seq, device: auth.deviceFingerprint, distanceM: Math.round(geo.distanceM) },
          });
          return ins.rows[0]!;
        });
        const [afterStats] = await courseStats(deps.db, auth.userId, term, session.course_id);
        const after = afterStats ? attendancePercent(afterStats.attended, afterStats.held) : null;
        return toResponse(session, auth.userId, record, false, before, after);
      } catch (err) {
        // Two concurrent submissions: the loser returns the winner's receipt.
        if (!isUniqueViolation(err, 'attendance_records_session_id_user_id_key')) throw err;
        const again = await deps.db.query<RecordRow>(
          `select id, marked_at, qr_seq, distance_m, receipt_signature, server_key_id, device_fingerprint
             from attendance_records where session_id = $1 and user_id = $2`,
          [session.id, auth.userId],
        );
        const [st] = await courseStats(deps.db, auth.userId, term, session.course_id);
        const pct = st ? attendancePercent(st.attended, st.held) : null;
        return toResponse(session, auth.userId, again.rows[0]!, true, pct, pct);
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
