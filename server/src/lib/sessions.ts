import { randomBytes, QR_SECRET_BYTES } from '@attendly/protocol';
import type { PoolClient } from 'pg';
import { isUniqueViolation } from '../db';
import { appendAudit } from './audit';

export interface NewSession {
  tenantId: string;
  courseId: string;
  room: string | null;
  lat: number;
  lng: number;
  radiusM: number;
  rotationS: number;
  status: 'scheduled' | 'live' | 'closed';
  scheduledStart: Date;
  scheduledEnd: Date;
  startedAt: Date | null;
  endedAt?: Date | null;
  createdBy: string | null;
  audit?: boolean;
}

function shortCode(bytes: number): string {
  return 'S-' + Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Creates a class session with a fresh 256-bit QR secret. */
export async function createSession(tx: PoolClient, s: NewSession): Promise<{ id: string; shortCode: string }> {
  const lecture = await tx.query<{ n: number }>(`select count(*) + 1 as n from class_sessions where course_id = $1 and status <> 'cancelled'`, [s.courseId]);
  for (let attempt = 0; ; attempt++) {
    const code = shortCode(attempt < 3 ? 2 : 4);
    await tx.query('savepoint new_session');
    try {
      const { rows } = await tx.query<{ id: string }>(
        `insert into class_sessions(tenant_id, course_id, short_code, lecture_no, room, lat, lng, radius_m, rotation_s, qr_secret, status,
                                    scheduled_start, scheduled_end, started_at, ended_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`,
        [
          s.tenantId,
          s.courseId,
          code,
          lecture.rows[0]!.n,
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
        ],
      );
      await tx.query('release savepoint new_session');
      if (s.audit !== false)
        await appendAudit(tx, {
          tenantId: s.tenantId,
          actorType: s.createdBy ? 'user' : 'system',
          actorId: s.createdBy,
          action: 'session.create',
          subject: `session:${rows[0]!.id}`,
          data: { code, status: s.status, radiusM: s.radiusM, rotationS: s.rotationS },
        });
      return { id: rows[0]!.id, shortCode: code };
    } catch (err) {
      await tx.query('rollback to savepoint new_session');
      if (!isUniqueViolation(err, 'class_sessions_short_code_key') || attempt >= 6) throw err;
    }
  }
}
