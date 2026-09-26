import { bytesToHex, randomBytes, QR_SECRET_BYTES } from '@attendly/protocol';
import type { PoolClient } from 'pg';
import { isUniqueViolation, type Queryable } from '../db';
import { appendAudit } from './audit';

export interface NewSession {
  tenantId: string;
  courseId: string;
  room: string | null;
  lat: number | null;
  lng: number | null;
  radiusM: number;
  rotationS: number;
  status: 'scheduled' | 'live' | 'closed';
  scheduledStart: Date;
  scheduledEnd: Date;
  startedAt: Date | null;
  endedAt?: Date | null;
  createdBy: string | null;
  audit?: boolean;
  mode?: 'qr' | 'manual';
  slotId?: string | null;
  roomId?: string | null;
}

function shortCode(bytes: number): string {
  return `S-${bytesToHex(randomBytes(bytes)).toUpperCase()}`;
}

/** Creates a class session with a fresh 256-bit QR secret. */
export async function createSession(tx: PoolClient, s: NewSession): Promise<{ id: string; shortCode: string }> {
  // Lecture numbers are given when a class actually happens (see assignLectureNo), so
  // pre-generated timetable occurrences don't consume numbers.
  const lecture =
    s.status === 'scheduled'
      ? null
      : (await tx.query<{ n: number }>(`select count(*) + 1 as n from class_sessions where course_id = $1 and status in ('live', 'closed')`, [s.courseId])).rows[0]!.n;
  let created: { id: string; shortCode: string } | undefined;
  for (let attempt = 0; !created; attempt++) {
    const code = shortCode(attempt < 3 ? 3 : 5);
    await tx.query('savepoint new_session');
    try {
      const { rows } = await tx.query<{ id: string }>(
        `insert into class_sessions(tenant_id, course_id, short_code, lecture_no, room, lat, lng, radius_m, rotation_s, qr_secret, status,
                                    scheduled_start, scheduled_end, started_at, ended_at, created_by, mode, slot_id, room_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id`,
        [
          s.tenantId,
          s.courseId,
          code,
          lecture,
          s.room,
          s.lat,
          s.lng,
          s.radiusM,
          s.rotationS,
          Buffer.from(randomBytes(QR_SECRET_BYTES)),
          s.status,
          s.scheduledStart,
          s.scheduledEnd,
          s.startedAt,
          s.endedAt ?? null,
          s.createdBy,
          s.mode ?? 'qr',
          s.slotId ?? null,
          s.roomId ?? null,
        ],
      );
      await tx.query('release savepoint new_session');
      created = { id: rows[0]!.id, shortCode: code };
    } catch (err) {
      await tx.query('rollback to savepoint new_session');
      if (!isUniqueViolation(err, 'class_sessions_short_code_key') || attempt >= 6) throw err;
    }
  }
  // Outside the retry block, so an audit failure surfaces as itself.
  if (s.audit !== false)
    await appendAudit(tx, {
      tenantId: s.tenantId,
      actorType: s.createdBy ? 'user' : 'system',
      actorId: s.createdBy,
      action: 'session.create',
      subject: `session:${created.id}`,
      data: { code: created.shortCode, status: s.status, radiusM: s.radiusM, rotationS: s.rotationS },
    });
  return created;
}

/** Gives a session the next lecture number of its course, once it goes live or is registered. */
export async function assignLectureNo(tx: Queryable, sessionId: string): Promise<void> {
  await tx.query(
    `update class_sessions s set lecture_no = (
        select count(*) + 1 from class_sessions o
         where o.course_id = s.course_id and o.id <> s.id and o.status in ('live', 'closed') and o.lecture_no is not null)
      where s.id = $1 and s.lecture_no is null`,
    [sessionId],
  );
}
