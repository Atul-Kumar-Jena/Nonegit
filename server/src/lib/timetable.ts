import type { PoolClient } from 'pg';
import { withTx, type Db, type Queryable } from '../db';
import { createSession } from './sessions';

/** How far ahead weekly slots are turned into concrete class sessions. */
export const MATERIALIZE_DAYS = 14;

interface Occurrence {
  slot_id: string;
  tenant_id: string;
  course_id: string;
  mode: 'qr' | 'manual';
  rotation_s: number;
  room_id: string | null;
  room_name: string | null;
  lat: number | null;
  lng: number | null;
  radius_m: number | null;
  created_by: string | null;
  starts: Date;
  ends: Date;
  day: string;
}

/**
 * Creates the scheduled class sessions for every active slot over the next
 * MATERIALIZE_DAYS days (in each institution's own timezone). Idempotent: an
 * occurrence that already exists — including one that was cancelled — is never
 * recreated (unique index on slot_id + scheduled_start).
 */
export async function materializeTimetable(db: Db, opts: { tenantId?: string; slotId?: string; days?: number } = {}): Promise<number> {
  const days = opts.days ?? MATERIALIZE_DAYS;
  const { rows } = await db.query<Occurrence>(
    `with slots as (
       select sl.*, t.timezone, r.name as room_name, r.lat, r.lng, r.radius_m
         from timetable_slots sl
         join courses c on c.id = sl.course_id and c.active
         join tenants t on t.id = sl.tenant_id and t.status = 'active'
         left join rooms r on r.id = sl.room_id and r.active
        where sl.active and ($1::uuid is null or sl.tenant_id = $1) and ($2::uuid is null or sl.id = $2)
     ),
     occ as (
       select s.*, d::date as day
         from slots s,
              generate_series((now() at time zone s.timezone)::date, (now() at time zone s.timezone)::date + ($3::int - 1), interval '1 day') d
        where extract(dow from d) = s.weekday
          and d::date >= s.valid_from and (s.valid_until is null or d::date <= s.valid_until)
     )
     select o.id as slot_id, o.tenant_id, o.course_id, o.mode, o.rotation_s, o.room_id, o.room_name, o.lat, o.lng, o.radius_m, o.created_by,
            ((o.day + o.start_time) at time zone o.timezone) as starts,
            ((o.day + o.end_time) at time zone o.timezone) as ends,
            to_char(o.day, 'YYYY-MM-DD') as day
       from occ o
      where ((o.day + o.end_time) at time zone o.timezone) > now()
        -- one class per slot per day: an occurrence that was moved, cancelled or
        -- substituted for that day is never re-created at its old time.
        and not exists (select 1 from class_sessions cs where cs.slot_id = o.id and cs.slot_date = o.day)`,
    [opts.tenantId ?? null, opts.slotId ?? null, days],
  );
  if (rows.length === 0) return 0;
  let created = 0;
  await withTx(db, async (tx) => {
    for (const o of rows) {
      await tx.query('savepoint occ');
      try {
        await createSession(tx, {
          tenantId: o.tenant_id,
          courseId: o.course_id,
          room: o.room_name,
          lat: o.lat,
          lng: o.lng,
          radiusM: o.radius_m ?? 50,
          rotationS: o.rotation_s,
          status: 'scheduled',
          scheduledStart: o.starts,
          scheduledEnd: o.ends,
          startedAt: null,
          createdBy: o.created_by,
          audit: false,
          mode: o.mode,
          slotId: o.slot_id,
          roomId: o.room_id,
          slotDate: o.day,
        });
        await tx.query('release savepoint occ');
        created++;
      } catch (err) {
        // A concurrent materialiser created it first — fine.
        await tx.query('rollback to savepoint occ');
        if ((err as { code?: string }).code !== '23505') throw err;
      }
    }
  });
  return created;
}

/**
 * After a slot changes: remove its future occurrences that nobody has used yet
 * (still scheduled, no marks, not individually adjusted), so they are regenerated
 * with the new details.
 */
export async function clearFutureOccurrences(tx: PoolClient | Queryable, slotId: string, now: Date): Promise<number> {
  const r = await tx.query(
    `delete from class_sessions s
      where s.slot_id = $1 and s.status = 'scheduled' and s.scheduled_start > $2
        and s.change_kind is null -- one-off adjustments (moved / substituted) are kept as they are
        and not exists (select 1 from attendance_records a where a.session_id = s.id)`,
    [slotId, now],
  );
  return r.rowCount ?? 0;
}
