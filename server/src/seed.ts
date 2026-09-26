import type { PoolClient } from 'pg';
import { receiptSigningString } from '@attendly/protocol';
import type { Config } from './config';
import { withTx, type Db } from './db';
import { appendAudit } from './lib/audit';
import { createServerSigner } from './lib/keys';
import { createSession } from './lib/sessions';

// ─────────────────────────────── seed ───────────────────────────────
/** Deterministic PRNG so the demo data is identical on every machine. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CAMPUS = { lat: 28.545, lng: 77.1926 };
const TZ = 'Asia/Kolkata';
const TZ_OFFSET_MIN = 330;

/** A wall-clock time in the demo timezone (IST, no DST) as a UTC Date. */
function istDate(daysFromToday: number, hour: number, minute = 0): Date {
  const nowIst = new Date(Date.now() + TZ_OFFSET_MIN * 60_000);
  const d = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate() + daysFromToday, hour, minute);
  return new Date(d - TZ_OFFSET_MIN * 60_000);
}

const COURSES = [
  { code: 'CS-301', title: 'Operating Systems', kind: 'theory', instructor: 'iyer', held: 28, days: [1, 3, 5], hour: 10, room: 'LH-2 · Block C', aarav: 24 },
  { code: 'MA-202', title: 'Linear Algebra', kind: 'theory', instructor: 'banerjee', held: 26, days: [1, 2, 4], hour: 9, room: 'LH-1 · Block A', aarav: 22 },
  { code: 'EC-204', title: 'Digital Circuits', kind: 'theory', instructor: 'khanna', held: 25, days: [2, 3, 5], hour: 12, room: 'LH-4 · Block B', aarav: 18 },
  { code: 'HS-101', title: 'Tech Comm.', kind: 'theory', instructor: 'joshi', held: 22, days: [2, 4], hour: 15, room: 'SR-3 · Block D', aarav: 19 },
  { code: 'CS-303L', title: 'OS Lab', kind: 'lab', instructor: 'iyer', held: 11, days: [4], hour: 14, room: 'Lab-5 · Block C', aarav: 10 },
] as const;

const FACULTY = [
  { key: 'iyer', name: 'Dr. N. Iyer', email: 'iyer@demo.attendly.app', dept: 'CSE' },
  { key: 'banerjee', name: 'Dr. S. Banerjee', email: 'banerjee@demo.attendly.app', dept: 'Mathematics' },
  { key: 'khanna', name: 'Dr. R. Khanna', email: 'khanna@demo.attendly.app', dept: 'ECE' },
  { key: 'joshi', name: 'Prof. A. Joshi', email: 'joshi@demo.attendly.app', dept: 'Humanities' },
];

const STUDENTS = [
  ['Aarav Reddy', '21CS1108', 'aarav@demo.attendly.app', '+919000000001'],
  ['Priya Sharma', '21CS1109', 'priya@demo.attendly.app', '+919000000002'],
  ['Rohan Kapoor', '21CS1110', 'rohan@demo.attendly.app', '+919000000003'],
  ['Aanya Verma', '21CS1111', 'aanya@demo.attendly.app', '+919000000004'],
  ['Vikram Singh', '21CS1112', 'vikram@demo.attendly.app', '+919000000005'],
  ['Ishita Patel', '21CS1113', 'ishita@demo.attendly.app', '+919000000006'],
  ['Karan Joshi', '21CS1114', 'karan@demo.attendly.app', '+919000000007'],
  ['Meera Nair', '21CS1115', 'meera@demo.attendly.app', '+919000000008'],
  ['Akash Mehta', '21CS1131', 'akash@demo.attendly.app', '+919000000009'],
  ['Rhea Iyer', '21CS1132', 'rhea@demo.attendly.app', '+919000000010'],
  ['Tanvi Desai', '21CS1133', 'tanvi@demo.attendly.app', '+919000000011'],
] as const;

/**
 * Creates the demo institution (idempotent). Used by `npm run seed` and, when
 * SEED_DEMO=true, automatically on server boot so a fresh cloud deploy is
 * immediately testable.
 */
export async function seedDemo(pool: Db, config: Config, opts: { reset?: boolean; log?: (msg: string) => void } = {}): Promise<boolean> {
  const reset = opts.reset ?? false;
  const log = opts.log ?? ((m: string) => console.log(m));
  const signer = createServerSigner(config.serverSigningSeed);
  const rand = mulberry32(20260516);
  const testerEmail = process.env.SEED_STUDENT_EMAIL?.trim().toLowerCase() || null;
  const testerPhone = process.env.SEED_STUDENT_PHONE?.trim() || null;
  if (testerPhone && !/^\+[1-9][0-9]{7,14}$/.test(testerPhone)) throw new Error('SEED_STUDENT_PHONE must look like +919876543210');
  return withTx(pool, async (tx) => {
    const existing = await tx.query<{ id: string }>(`select id from tenants where slug = 'demo'`);
    if (existing.rows[0]) {
      if (!reset) {
        log('Demo institution already exists. Run "npm run seed -- --reset" to recreate it.');
        return false;
      }
      await tx.query(`delete from tenants where id = $1`, [existing.rows[0].id]);
      log('Removed previous demo institution.');
    }
    const domains = ['demo.attendly.app'];
    if (testerEmail) domains.push(testerEmail.split('@')[1]!);
    const termStart = istDate(-84, 0);
    const t = await tx.query<{ id: string }>(
      `insert into tenants(slug, name, email_domains, timezone, min_attendance, term_name, term_start)
         values ('demo', 'Demo Institute of Technology', $1, $2, 75, 'Spring Term', ($3::timestamptz at time zone $2)::date) returning id`,
      [Array.from(new Set(domains)), TZ, termStart],
    );
    const tenantId = t.rows[0]!.id;

    const facultyIds: Record<string, string> = {};
    for (const f of FACULTY) {
      const r = await tx.query<{ id: string }>(
        `insert into users(tenant_id, role, full_name, email, department) values ($1, 'admin', $2, $3, $4) returning id`,
        [tenantId, f.name, f.email, f.dept],
      );
      facultyIds[f.key] = r.rows[0]!.id;
    }
    await tx.query(
      `insert into users(tenant_id, role, full_name, email, department) values ($1, 'developer', 'Root Developer', 'root@demo.attendly.app', 'Platform')`,
      [tenantId],
    );

    const studentIds: string[] = [];
    for (const [name, roll, email, phone] of STUDENTS) {
      const r = await tx.query<{ id: string }>(
        `insert into users(tenant_id, role, full_name, email, phone, roll_no, department, semester) values ($1, 'student', $2, $3, $4, $5, 'CSE', 6) returning id`,
        [tenantId, name, email, phone, roll],
      );
      studentIds.push(r.rows[0]!.id);
    }
    let testerId: string | null = null;
    if (testerEmail || testerPhone) {
      const clash = await tx.query('select 1 from users where email = $1 or phone = $2', [testerEmail, testerPhone]);
      if (clash.rowCount) throw new Error('SEED_STUDENT_EMAIL / SEED_STUDENT_PHONE is already used by another account in this database.');
      const r = await tx.query<{ id: string }>(
        `insert into users(tenant_id, role, full_name, email, phone, roll_no, department, semester) values ($1, 'student', 'Test Student', $2, $3, '21CS1199', 'CSE', 6) returning id`,
        [tenantId, testerEmail, testerPhone],
      );
      testerId = r.rows[0]!.id;
      studentIds.push(testerId);
    }

    let records = 0;
    for (const c of COURSES) {
      const cr = await tx.query<{ id: string }>(`insert into courses(tenant_id, code, title, kind, instructor_id) values ($1, $2, $3, $4, $5) returning id`, [
        tenantId,
        c.code,
        c.title,
        c.kind,
        facultyIds[c.instructor],
      ]);
      const courseId = cr.rows[0]!.id;
      for (const sid of studentIds) await tx.query('insert into enrollments(course_id, user_id) values ($1, $2)', [courseId, sid]);

      // Past sessions: walk back from yesterday over this course's weekdays.
      const dates: Date[] = [];
      for (let d = -1; dates.length < c.held && d > -200; d--) {
        const day = istDate(d, c.hour);
        const weekday = new Date(day.getTime() + TZ_OFFSET_MIN * 60_000).getUTCDay();
        if ((c.days as readonly number[]).includes(weekday)) dates.push(day);
      }
      dates.reverse();
      // Aarav gets the exact numbers from the design; everyone else ~65–97%.
      const aaravMiss = new Set<number>();
      while (aaravMiss.size < c.held - c.aarav) aaravMiss.add(Math.floor(rand() * c.held));
      const rates = studentIds.map((_, i) => (i === 0 ? 1 : 0.65 + rand() * 0.32));
      for (let i = 0; i < dates.length; i++) {
        const start = dates[i]!;
        const s = await createSession(tx, {
          tenantId,
          courseId,
          room: c.room,
          lat: CAMPUS.lat,
          lng: CAMPUS.lng,
          radiusM: 50,
          rotationS: 7,
          status: 'closed',
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 60 * 60_000),
          startedAt: start,
          endedAt: new Date(start.getTime() + 60 * 60_000),
          createdBy: facultyIds[c.instructor]!,
          audit: false,
        });
        for (let si = 0; si < studentIds.length; si++) {
          const present = si === 0 ? !aaravMiss.has(i) : rand() < rates[si]!;
          if (!present) continue;
          await insertHistoricRecord(tx, signer, s.id, studentIds[si]!, new Date(start.getTime() + (3 + Math.floor(rand() * 15)) * 60_000));
          records++;
        }
      }
      // Today's timetable (scheduled; start them from the dev console or Admin app).
      const todayWeekday = new Date(Date.now() + TZ_OFFSET_MIN * 60_000).getUTCDay();
      if ((c.days as readonly number[]).includes(todayWeekday) || c.code === 'CS-301') {
        const start = istDate(0, c.hour);
        await createSession(tx, {
          tenantId,
          courseId,
          room: c.room,
          lat: CAMPUS.lat,
          lng: CAMPUS.lng,
          radiusM: 50,
          rotationS: 7,
          status: 'scheduled',
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 60 * 60_000),
          startedAt: null,
          createdBy: facultyIds[c.instructor]!,
          audit: false,
        });
      }
    }
    await appendAudit(tx, { tenantId, actorType: 'system', action: 'seed.demo', data: { students: studentIds.length, records } });
    log(`Seeded "Demo Institute of Technology": ${studentIds.length} students, ${COURSES.length} courses, ${records} historic attendance records.`);
    log('Sign in to the Student app as  aarav@demo.attendly.app  (or +919000000001).');
    if (testerId) log(`Also created your test account: ${testerEmail ?? ''} ${testerPhone ?? ''}`.trim());
    return true;
  });
}

async function insertHistoricRecord(tx: PoolClient, signer: ReturnType<typeof createServerSigner>, sessionId: string, userId: string, markedAt: Date) {
  const id = (await tx.query<{ id: string }>('select gen_random_uuid() as id')).rows[0]!.id;
  const fingerprint = 'imported';
  const sig = signer.sign(
    receiptSigningString({
      recordId: id,
      sessionId,
      userId,
      markedAt: markedAt.toISOString(),
      deviceFingerprint: fingerprint,
      qrSeq: 0,
      serverKeyId: signer.kid,
    }),
  );
  await tx.query(
    `insert into attendance_records(id, session_id, user_id, marked_at, qr_seq, receipt_signature, server_key_id, device_fingerprint, source)
     values ($1, $2, $3, $4, 0, $5, $6, $7, 'import')`,
    [id, sessionId, userId, markedAt, Buffer.from(sig), signer.kid, fingerprint],
  );
}
