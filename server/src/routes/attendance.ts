import type { FastifyInstance } from 'fastify';
import {
  IMPOSSIBLE_TRAVEL_MIN_M,
  IMPOSSIBLE_TRAVEL_MPS,
  MAX_LOCATION_AGE_MS,
  MarkBody,
  TELEPORT_MIN_M,
  TELEPORT_SPEED_MPS,
  distanceMeters,
  fuseSamples,
  maxUnexplainedSpeed,
  type GeoSample,
  REJECTION_CODES,
  attendancePercent,
  currentQrSeq,
  evaluateGeofence,
  isQrSeqFresh,
  parseQrToken,
  seqLabel,
  toB64url,
  verifyQrMac,
  isQrFreshAt,
  type MarkPresent,
  type MarkResponse,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { tenantFlag } from '../lib/flags';
import { hardwareRequired } from '../lib/device-trust';
import { insertNotifications } from '../lib/notify';
import { isUniqueViolation, withTx, type Queryable } from '../db';
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
const NOT_STUDENTS_FAULT = ['E-PAUSED', 'E-SESSION-CLOSED', 'E-NOT-STARTED'];

/** Grace around a class's scheduled window for early/late scans. */
const WINDOW_GRACE_MS = 15 * 60_000;
/**
 * A live scan must reach the server within this long of being scanned; anything older is an offline
 * upload. Freshness of the rotating code is judged within this bound, so a forwarded screenshot of the
 * screen is stale after ~20 s.
 */
const OFFLINE_THRESHOLD_MS = 15_000;
/** Cushion around the scan / upload when checking whether the phone was online in between. */
const ONLINE_EVIDENCE_CUSHION_MS = 3 * 60_000;
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
  center_accuracy_m: number | null;
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
  scan_rounds: number;
  round_no: number;
  round_opened_at: Date[];
}

/** A scan must be made within this long of the class ending (only clock differences, no more). */
const AFTER_END_GRACE_MS = 2_000;

/** Which round a scan made at `at` belongs to: round 1 from the start, round k once it was opened. */
function roundAt(s: SessionRow, at: number): number {
  let r = 1;
  for (const t of s.round_opened_at ?? []) if (t.getTime() <= at) r++;
  return Math.min(r, s.round_no);
}

/** Every enrolled (active) student is present: the class has done its job, close it. */
export async function closeIfEveryoneMarked(tx: Queryable, sessionId: string, courseId: string, at: Date): Promise<boolean> {
  const { rows } = await tx.query<{ enrolled: number; present: number }>(
    `select (select count(*)::int from enrollments e join users u on u.id = e.user_id and u.status = 'active' and u.role = 'student' where e.course_id = $2) as enrolled,
            (select count(*)::int from attendance_records a join users u on u.id = a.user_id and u.status = 'active' where a.session_id = $1 and a.revoked_at is null) as present`,
    [sessionId, courseId],
  );
  const c = rows[0]!;
  if (c.enrolled === 0 || c.present < c.enrolled) return false;
  const r = await tx.query(`update class_sessions set status = 'closed', ended_at = $2, end_reason = 'all_marked' where id = $1 and status = 'live'`, [sessionId, at]);
  return (r.rowCount ?? 0) > 0;
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

function toResponse(s: SessionRow, userId: string, r: RecordRow, alreadyMarked: boolean, before: number | null, after: number | null): MarkPresent {
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
  async function existingReceipt(session: SessionRow, auth: AuthContext): Promise<MarkPresent | null> {
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

      // 0. The phone itself. Once its key is in the security chip, the chip must sign every scan
      //    (a copied software key alone can't mark), and Google-proven tampering is refused.
      if (auth.attestFailure)
        throw new ScanRejection('E-INTEGRITY', 'Google’s hardware check found this phone rooted, unlocked or running a modified app.', { signal: 'attestation', code: auth.attestFailure });
      if (auth.hardwareKey && !auth.hardwareSigned) throw new ScanRejection('E-DEVICE', 'This scan wasn’t signed by your phone’s security chip.', { signal: 'hw_sig' });
      if (!auth.hardwareKey && (await hardwareRequired(deps.db, deps, auth.tenantId, auth.devicePlatform)))
        throw new ScanRejection('E-DEVICE', 'Your phone isn’t secured yet. Open Attendly while online, then scan again.', { signal: 'hw_missing' });

      // 1. Token must be a well-formed, authentic QR for a session of *this* institution.
      const parsed = parseQrToken(body.qr);
      if (!parsed) throw new ScanRejection('E-QR-INVALID', 'The scanned code is not an Attendly session code.', { reason: 'malformed' });
      const { rows } = await deps.db.query<SessionRow>(
        `select s.*, coalesce(r.name, s.room) as room,
                coalesce(s.center_accuracy_m, case when s.lat = r.lat and s.lng = r.lng then r.center_accuracy_m end) as center_accuracy_m,
                c.code as course_code, c.title as course_title, c.kind as course_kind
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

      // 3. When was the code scanned? Never from the phone's wall clock alone (it can be changed in
      //    Settings): only the *delay* between scanning and sending counts, measured on one clock —
      //    the since-boot clock when the phone has one, else the same wall clock that signed this
      //    request (a shifted clock cancels out). The scan time is then server time minus that delay.
      let waited = 0;
      if (body.clock?.sendMs !== undefined) waited = body.clock.sendMs - body.clock.scanMs;
      else if (body.scannedAt !== undefined) waited = auth.requestTs - body.scannedAt;
      if (waited < -OFFLINE_THRESHOLD_MS) throw new ScanRejection('E-GPS-STALE', 'This scan is dated in the future. Enable automatic date & time.', { waited });
      waited = Math.max(0, waited);
      const scannedAt = now - waited;
      const offline = waited > OFFLINE_THRESHOLD_MS;
      // The phone's own account of the scan time must agree with the delay (allowing clock drift).
      if (body.clock?.sendMs !== undefined && body.scannedAt !== undefined && Math.abs(body.scannedAt - (auth.requestTs - waited)) > 10 * 60_000)
        throw new ScanRejection('E-QR-INVALID', 'The time of this scan doesn’t add up. Turn on automatic date & time and scan the live code again.', { signal: 'clock_mismatch' });
      if (offline && now - scannedAt > MAX_OFFLINE_AGE_MS)
        throw new ScanRejection('E-EXPIRED', 'Offline scans must be uploaded within 24 hours.', { ageMs: now - scannedAt, offline: true });
      if (offline) {
        if (await tenantFlag(deps.db, auth.tenantId, 'offline_scans_off'))
          throw new ScanRejection('E-EXPIRED', 'Your institution accepts only live scans — scan the code on screen while you have internet.', { offline: true, signal: 'offline_off' });
        // A genuine offline scan is uploaded as soon as the phone is back online. If this phone used the app
        // online well after the "scan" without uploading it, the code was old or forwarded.
        const online = await deps.db.query<{ minute: Date }>(
          'select minute from device_online where device_id = $1 and minute > $2 and minute < $3 order by minute limit 1',
          [auth.deviceId, new Date(scannedAt + ONLINE_EVIDENCE_CUSHION_MS), new Date(now - ONLINE_EVIDENCE_CUSHION_MS)],
        );
        if (online.rows[0])
          throw new ScanRejection('E-QR-INVALID', 'This phone was online after that scan but didn’t send it then — old or forwarded codes aren’t accepted.', {
            offline: true,
            signal: 'online_after_scan',
            onlineAt: online.rows[0].minute.toISOString(),
          });
      }

      // 4. Session state at the moment of scanning, and the roster.
      if (session.mode !== 'qr') throw new ScanRejection('E-SESSION-CLOSED', 'This class uses a paper/manual register.', { mode: session.mode });
      if (session.status === 'cancelled') throw new ScanRejection('E-SESSION-CLOSED', 'This class was cancelled.', { status: session.status });
      const opens = (session.started_at ?? session.scheduled_start).getTime() - WINDOW_GRACE_MS;
      const closes =
        session.status === 'live' ? Number.POSITIVE_INFINITY : (session.ended_at ?? session.scheduled_end).getTime() + (session.ended_at ? AFTER_END_GRACE_MS : WINDOW_GRACE_MS);
      if (scannedAt < opens || scannedAt > closes) throw new ScanRejection('E-SESSION-CLOSED', undefined, { status: session.status });
      if (session.status === 'closed' && !offline) throw new ScanRejection('E-SESSION-CLOSED', undefined, { status: session.status });
      if (session.lat === null || session.lng === null)
        throw new ScanRejection('E-NOT-STARTED', undefined, { reason: 'no_location' });
      const enrolled = await deps.db.query('select 1 from enrollments where course_id = $1 and user_id = $2', [session.course_id, auth.userId]);
      if (enrolled.rowCount !== 1) throw new ScanRejection('E-NOT-ENROLLED', undefined, { course: session.course_code });

      // 5. Freshness of the rotating token at the moment it was scanned — strict: the code on screen
      //    then (a neighbour only within 1.5 s of the switch). A forwarded screenshot is scanned later,
      //    when that code is long gone. (The GPS fix after scanning may take a few seconds; that
      //    delay is measured on the phone's since-boot clock and doesn't count against the student.)
      const judgedAt = scannedAt;
      const cur = currentQrSeq(judgedAt, session.rotation_s);
      if (!isQrFreshAt(parsed.seq, judgedAt, session.rotation_s))
        throw new ScanRejection('E-EXPIRED', `Token ${seqLabel(parsed.seq)} expired — the live code was ${seqLabel(cur)}.`, { seq: parsed.seq, current: cur, offline });
      void isQrSeqFresh;

      // 6. Location: genuine, fresh relative to the scan, precise and inside the geofence.
      //    The phone sends its raw fixes; the server fuses them itself rather than trusting a summary.
      const loc = body.location;
      const raw: GeoSample[] = loc.samples?.length ? loc.samples : [{ lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM, t: loc.capturedAt, mocked: loc.mocked }];
      if (loc.mocked || raw.some((x) => x.mocked)) throw new ScanRejection('E-MOCK', 'The operating system flagged this location as coming from a mock-location provider.', { signal: 'os_mock_flag' });
      // Fix times are on the phone's clock: compare them with the phone's own scan time.
      const phoneScanAt = body.scannedAt ?? auth.requestTs;
      const fresh = raw.filter((x) => Math.abs(phoneScanAt - x.t) <= MAX_LOCATION_AGE_MS);
      if (!fresh.length) throw new ScanRejection('E-GPS-STALE', undefined, { ageMs: phoneScanAt - loc.capturedAt });
      if (fresh.some((x) => !(x.accuracyM > 0))) throw new ScanRejection('E-MOCK', 'GPS reported perfect (0 m) accuracy, which real hardware never does.', { signal: 'zero_accuracy' });
      const jump = maxUnexplainedSpeed(fresh);
      if (jump.speedMps > TELEPORT_SPEED_MPS && jump.jumpM > TELEPORT_MIN_M)
        throw new ScanRejection('E-MOCK', `Your location jumped ${Math.round(jump.jumpM)} m in an instant while scanning.`, { signal: 'teleport', jumpM: Math.round(jump.jumpM) });
      const fused = fuseSamples(fresh)!;
      const strict = await tenantFlag(deps.db, auth.tenantId, 'strict_geo');
      const geo = evaluateGeofence({
        centerLat: session.lat,
        centerLng: session.lng,
        radiusM: session.radius_m,
        lat: fused.lat,
        lng: fused.lng,
        accuracyM: fused.accuracyM,
        centerAccuracyM: session.center_accuracy_m,
        strict,
      });
      const where = session.room ?? 'the classroom';
      if (!geo.ok) {
        const distance = Math.round(geo.distanceM);
        const data = { distanceM: distance, accuracyM: Math.round(fused.accuracyM), radiusM: session.radius_m, samples: fresh.length, offline };
        if (geo.reason === 'imprecise') throw new ScanRejection('E-GPS-WEAK', `Your location is only accurate to ±${Math.round(fused.accuracyM)}m.`, data);
        throw new ScanRejection('E-GEO', `You're ${distance}m from ${where}. Sessions accept marks only inside the ${session.radius_m}m perimeter.`, data);
      }
      // Impossible travel: compared with the student's scans closest in time (either side, other classes).
      const near = await deps.db.query<{ lat: number; lng: number; accuracy_m: number | null; marked_at: Date }>(
        `(select lat, lng, accuracy_m, marked_at from attendance_records
           where user_id = $1 and session_id <> $2 and lat is not null and revoked_at is null and marked_at <= $3 and marked_at > $3 - interval '6 hours'
           order by marked_at desc limit 1)
         union all
         (select lat, lng, accuracy_m, marked_at from attendance_records
           where user_id = $1 and session_id <> $2 and lat is not null and revoked_at is null and marked_at > $3 and marked_at < $3 + interval '6 hours'
           order by marked_at asc limit 1)`,
        [auth.userId, session.id, new Date(scannedAt)],
      );
      for (const r of near.rows) {
        const gap = distanceMeters(r.lat, r.lng, fused.lat, fused.lng) - (r.accuracy_m ?? 0) - fused.accuracyM;
        const secs = Math.max(1, Math.abs(scannedAt - r.marked_at.getTime()) / 1000);
        if (gap > IMPOSSIBLE_TRAVEL_MIN_M && gap / secs > IMPOSSIBLE_TRAVEL_MPS)
          throw new ScanRejection('E-MOCK', `This scan is ${Math.round(gap / 1000)} km from your other scan ${Math.round(secs / 60)} min apart — no one travels that fast.`, {
            signal: 'impossible_travel',
            km: Math.round(gap / 100) / 10,
            minutes: Math.round(secs / 60),
          });
      }

      // 6b. Layered scans: each scan counts for the round open at that moment; present only after all.
      if (session.scan_rounds > 1) {
        const round = roundAt(session, scannedAt);
        await deps.db.query(
          `insert into scan_round_marks(session_id, user_id, round, device_id, marked_at) values ($1, $2, $3, $4, $5) on conflict do nothing`,
          [session.id, auth.userId, round, auth.deviceId, new Date(scannedAt)],
        );
        const done = (await deps.db.query<{ n: number }>('select count(*)::int as n from scan_round_marks where session_id = $1 and user_id = $2', [session.id, auth.userId])).rows[0]!.n;
        if (done < session.scan_rounds)
          return {
            status: 'round',
            sessionId: session.id,
            courseCode: session.course_code,
            courseTitle: session.course_title,
            offline,
            round: { done, required: session.scan_rounds, current: round },
          } satisfies MarkResponse;
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
                                            device_signature, request_digest, receipt_signature, server_key_id, device_fingerprint, offline, hw_signed, gps_samples)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
             returning ${RECORD_COLUMNS}`,
            [
              recordId,
              session.id,
              auth.userId,
              auth.deviceId,
              markedAt,
              parsed.seq,
              fused.lat,
              fused.lng,
              fused.accuracyM,
              geo.distanceM,
              auth.signature,
              auth.requestDigest,
              receipt,
              deps.signer.kid,
              auth.deviceFingerprint,
              offline,
              auth.hardwareSigned,
              fresh.length,
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
          // A scan saved without internet and confirmed now: tell the student it counted.
          if (offline) {
            const clock = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: term.timezone });
            const day = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: term.timezone });
            const lecture = session.lecture_no ? ` · ${session.course_kind === 'lab' ? 'Lab' : 'Lecture'} ${session.lecture_no}` : '';
            await insertNotifications(tx, auth.tenantId, [
              {
                userId: auth.userId,
                kind: 'attendance',
                title: `✅ Attendance marked · ${session.course_code}`,
                body: `${session.course_title}${lecture}\nScanned ${day.format(markedAt)}, ${clock.format(markedAt)} without internet — now confirmed.${after !== null ? ` Your attendance: ${after}%.` : ''}`,
                data: { sessionId: session.id, courseId: session.course_id, recordId },
              },
            ]);
          }
          // Everyone is here: the class closes itself (the QR stops working everywhere).
          if (!offline && (await closeIfEveryoneMarked(tx, session.id, session.course_id, new Date(now))))
            await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'system', action: 'session.auto_end', subject: `session:${session.id}`, data: { reason: 'all_marked' } });
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
