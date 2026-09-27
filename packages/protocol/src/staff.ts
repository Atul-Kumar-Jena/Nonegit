/**
 * Institute (staff) API contract + student timetable/history additions.
 * Shared by the server (request validation) and the apps (response validation).
 */
import { z } from 'zod';
import { DeviceSummary, EmailIdentifier, IsoDate, PhoneIdentifier, SessionChange, SessionStatus, SubjectStat, UserSummary } from './schemas';

const uuid = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional();
/** Local wall-clock time "HH:MM" (24h). */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24h)');
/** Calendar date "YYYY-MM-DD". */
export const YMD = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Date must be YYYY-MM-DD')
  .refine((v) => new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, 'That date doesn’t exist');
export const SessionMode = z.enum(['qr', 'manual']);
export type SessionMode = z.infer<typeof SessionMode>;
export const CourseKind = z.enum(['theory', 'lab']);
const lat = z.number().gte(-90).lte(90);
const lng = z.number().gte(-180).lte(180);

// ───────────────────────────── institution ─────────────────────────────

export const InstitutionSettings = z.object({
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  minAttendance: z.number(),
  termName: z.string(),
  termStart: YMD,
  emailDomains: z.array(z.string()),
  deviceResetLimit: z.number().int(),
});
export type InstitutionSettings = z.infer<typeof InstitutionSettings>;

export const UpdateInstitutionBody = z
  .object({
    name: text(120),
    timezone: text(64),
    minAttendance: z.number().min(0).max(100),
    termName: text(60),
    termStart: YMD,
    emailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Invalid email domain')).max(20),
    deviceResetLimit: z.number().int().min(0).max(20),
  })
  .partial();
export type UpdateInstitutionBody = z.infer<typeof UpdateInstitutionBody>;

/** Extra powers an admin can give a professor (admins have them all). */
export const StaffPermission = z.enum(['people', 'courses', 'planner', 'devices', 'broadcast']);
export type StaffPermission = z.infer<typeof StaffPermission>;
export const STAFF_PERMISSIONS: readonly { key: StaffPermission; label: string; detail: string }[] = [
  { key: 'people', label: 'People', detail: 'Add and edit students and professors, paste class lists, unbind phones, reset authenticators.' },
  { key: 'courses', label: 'Courses & timetable', detail: 'Every course and its students, the weekly timetable, rooms.' },
  { key: 'planner', label: 'Planner & cover', detail: 'Drag-and-drop planner, publish changes, give a class to another professor.' },
  { key: 'devices', label: 'Phones & scans', detail: 'Approve students moving to a new phone, review suspicious scans.' },
  { key: 'broadcast', label: 'Notices to everyone', detail: 'Send notices to the whole institution, all students or all faculty (any professor can already post to batches and their own subjects).' },
];

export const StaffMe = z.object({
  user: UserSummary,
  device: DeviceSummary,
  institution: InstitutionSettings,
  /** What this person may do beyond teaching (admins: all of them). */
  permissions: z.array(StaffPermission).default([]),
  /** Batches this person mentors (their students' phone requests come to them). */
  mentorOf: z.array(z.object({ id: uuid, name: z.string() })).default([]),
  /** The institution's main admin: the only one who adds, changes or removes other admins. */
  owner: z.boolean().default(false),
});
export type StaffMe = z.infer<typeof StaffMe>;

/** Professors and admins of the institution (to pick a mentor, a substitute…). */
export const Colleague = z.object({ id: uuid, name: z.string(), role: z.enum(['teacher', 'admin']), department: z.string().nullable() });
export type Colleague = z.infer<typeof Colleague>;

// ───────────────────────────── rooms ─────────────────────────────

export const Room = z.object({
  id: uuid,
  name: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  radiusM: z.number().int(),
  /** How precisely the centre was measured (averaged fixes), metres. */
  centerAccuracyM: z.number().nullable().default(null),
  active: z.boolean(),
});
export type Room = z.infer<typeof Room>;

export const RoomBody = z
  .object({
    name: text(60),
    lat: lat.nullable().optional(),
    lng: lng.nullable().optional(),
    centerAccuracyM: z.number().min(0).max(1000).nullable().optional(),
    radiusM: z.number().int().min(10).max(1000).default(50),
    active: z.boolean().default(true),
  })
  .refine((r) => (r.lat == null) === (r.lng == null), { message: 'Set both latitude and longitude, or neither' });
export type RoomBody = z.infer<typeof RoomBody>;

// ───────────────────────────── people ─────────────────────────────

export const StaffRole = z.enum(['teacher', 'admin']);
export const PersonRole = z.enum(['student', 'teacher', 'admin']);

export const Person = z.object({
  id: uuid,
  role: z.enum(['student', 'teacher', 'admin', 'developer']),
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  rollNo: z.string().nullable(),
  department: z.string().nullable(),
  semester: z.number().int().nullable(),
  status: z.enum(['active', 'suspended']),
  device: z
    .object({ model: z.string(), fingerprint: z.string(), boundAt: IsoDate.nullable(), hardware: z.enum(['none', 'tee', 'strongbox']).default('none') })
    .nullable(),
  courseIds: z.array(uuid),
  /** Signs in with an authenticator app (Google Authenticator) instead of emailed codes. */
  authenticator: z.boolean().default(false),
  /** Professors only: extra powers given by an admin. */
  permissions: z.array(StaffPermission).default([]),
  /** The institution's main admin (set by Attendly when the institution was created). */
  owner: z.boolean().default(false),
  /** A setup code is out and not used yet (they haven't linked Google Authenticator). */
  setupPending: z.boolean().default(false),
});
export type Person = z.infer<typeof Person>;

/** Admins only: make someone an admin or a professor, and choose a professor's extra powers. */
export const StaffAccessBody = z.object({ role: z.enum(['teacher', 'admin']), permissions: z.array(StaffPermission).max(5).default([]) });
export type StaffAccessBody = z.infer<typeof StaffAccessBody>;

export const PersonBody = z
  .object({
    role: PersonRole,
    fullName: text(120),
    email: EmailIdentifier.nullable().optional(),
    phone: PhoneIdentifier.nullable().optional(),
    rollNo: optText(40),
    department: optText(60),
    semester: z.number().int().min(1).max(20).nullable().optional(),
    courseIds: z.array(uuid).max(50).optional(),
  })
  .refine((p) => p.email || p.phone, { message: 'Give an email or a phone number so the person can sign in' });
export type PersonBody = z.infer<typeof PersonBody>;

export const PersonUpdateBody = z.object({
  fullName: text(120).optional(),
  email: EmailIdentifier.nullable().optional(),
  phone: PhoneIdentifier.nullable().optional(),
  rollNo: optText(40),
  department: optText(60),
  semester: z.number().int().min(1).max(20).nullable().optional(),
  status: z.enum(['active', 'suspended']).optional(),
  courseIds: z.array(uuid).max(50).optional(),
  /** Unbind the person's phone (they bind a new one at next sign-in). */
  resetDevice: z.boolean().optional(),
});
export type PersonUpdateBody = z.infer<typeof PersonUpdateBody>;

export const BulkImportBody = z.object({ rows: z.array(z.unknown()).min(1).max(500), courseIds: z.array(uuid).max(50).default([]), batchId: uuid.optional() });
export const BulkImportResponse = z.object({
  created: z.number().int(),
  /** Already registered (same roll no. or email) — added to the batch instead. */
  addedExisting: z.number().int().default(0),
  skipped: z.array(z.object({ row: z.number().int(), reason: z.string() })),
});
export type BulkImportResponse = z.infer<typeof BulkImportResponse>;

// ───────────────────────────── courses ─────────────────────────────

export const CourseSummary = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  kind: CourseKind,
  defaultMode: SessionMode,
  instructor: z.object({ id: uuid, name: z.string() }).nullable(),
  studentCount: z.number().int(),
  active: z.boolean(),
});
export type CourseSummary = z.infer<typeof CourseSummary>;

export const CourseBody = z.object({
  code: text(20).transform((s) => s.toUpperCase()),
  title: text(120),
  kind: CourseKind.default('theory'),
  defaultMode: SessionMode.default('qr'),
  instructorId: uuid.nullable().optional(),
  active: z.boolean().default(true),
});
export type CourseBody = z.infer<typeof CourseBody>;

export const EnrollmentBody = z.object({ add: z.array(uuid).max(1000).default([]), remove: z.array(uuid).max(1000).default([]) });
export type EnrollmentBody = z.infer<typeof EnrollmentBody>;

export const RosterEntry = z.object({ userId: uuid, fullName: z.string(), rollNo: z.string().nullable() });
export type RosterEntry = z.infer<typeof RosterEntry>;

// ───────────────────────────── timetable ─────────────────────────────

export const Slot = z.object({
  id: uuid,
  courseId: uuid,
  courseCode: z.string(),
  courseTitle: z.string(),
  instructor: z.string().nullable(),
  weekday: z.number().int().min(0).max(6),
  start: HHMM,
  end: HHMM,
  room: z.object({ id: uuid, name: z.string() }).nullable(),
  mode: SessionMode,
  rotationS: z.number().int(),
  validFrom: YMD,
  validUntil: YMD.nullable(),
  active: z.boolean(),
});
export type Slot = z.infer<typeof Slot>;

export const SlotBody = z
  .object({
    courseId: uuid,
    weekday: z.number().int().min(0).max(6),
    start: HHMM,
    end: HHMM,
    roomId: uuid.nullable().optional(),
    mode: SessionMode.default('qr'),
    rotationS: z.number().int().min(3).max(60).default(7),
    validFrom: YMD.optional(),
    validUntil: YMD.nullable().optional(),
    active: z.boolean().default(true),
  })
  .refine((s) => s.end > s.start, { message: 'End time must be after start time', path: ['end'] });
export type SlotBody = z.infer<typeof SlotBody>;

// ───────────────────────────── sessions ─────────────────────────────

export const StaffSession = z.object({
  id: uuid,
  code: z.string(),
  courseId: uuid,
  courseCode: z.string(),
  courseTitle: z.string(),
  lectureNo: z.number().int().nullable(),
  status: SessionStatus,
  mode: SessionMode,
  scheduledStart: IsoDate,
  scheduledEnd: IsoDate,
  startedAt: IsoDate.nullable(),
  endedAt: IsoDate.nullable(),
  room: z.object({ id: uuid, name: z.string() }).nullable(),
  roomLabel: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  radiusM: z.number().int(),
  rotationS: z.number().int(),
  marked: z.number().int(),
  enrolled: z.number().int(),
  flagged: z.number().int(),
  /** The course's own teacher, and who is actually taking this class if someone else is. */
  teacher: z.object({ id: uuid, name: z.string() }).nullable().default(null),
  substitute: z.object({ id: uuid, name: z.string() }).nullable().default(null),
  change: SessionChange.nullable().default(null),
  /** The QR is on screen now (phone or big screen): attendance is being taken. */
  showingQr: z.boolean().default(false),
  /** Log 1: the class time started (the professor was reminded). */
  dueAt: IsoDate.nullable().default(null),
  /** Log 2 is startedAt: the professor arrived and started the class — this many minutes after its time. */
  lateMin: z.number().int().nullable().default(null),
  /** The class time ran out and the professor never started it. */
  missed: z.boolean().default(false),
});
export type StaffSession = z.infer<typeof StaffSession>;

export const CreateSessionBody = z
  .object({
    courseId: uuid,
    date: YMD,
    start: HHMM,
    end: HHMM,
    roomId: uuid.nullable().optional(),
    mode: SessionMode.default('qr'),
    rotationS: z.number().int().min(3).max(60).default(7),
  })
  .refine((s) => s.end > s.start, { message: 'End time must be after start time', path: ['end'] });
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

export const StartSessionBody = z.object({
  mode: SessionMode,
  lat: lat.nullable().optional(),
  lng: lng.nullable().optional(),
  /** How precisely the teacher's phone measured the classroom centre (averaged fixes), metres. */
  centerAccuracyM: z.number().min(0).max(1000).nullable().optional(),
  radiusM: z.number().int().min(10).max(1000).optional(),
  rotationS: z.number().int().min(3).max(60).optional(),
  /** Set when a session was started offline and is being synced later (server-corrected ms). */
  startedAt: z.number().int().positive().optional(),
  clientRef: z.string().min(8).max(64).optional(),
});
export type StartSessionBody = z.infer<typeof StartSessionBody>;

export const EndSessionBody = z.object({ endedAt: z.number().int().positive().optional(), clientRef: z.string().min(8).max(64).optional() });
export type EndSessionBody = z.infer<typeof EndSessionBody>;

export const SessionWithSecret = z.object({ session: StaffSession, secret: z.string().nullable() });
export type SessionWithSecret = z.infer<typeof SessionWithSecret>;

export const OfflinePack = z.object({
  generatedAt: z.number(),
  timezone: z.string(),
  sessions: z.array(StaffSession.extend({ secret: z.string().nullable() })),
  rosters: z.record(z.string(), z.array(RosterEntry)),
});
export type OfflinePack = z.infer<typeof OfflinePack>;

export const FeedEntry = z.object({
  userId: uuid,
  fullName: z.string(),
  rollNo: z.string().nullable(),
  present: z.boolean(),
  source: z.enum(['scan', 'manual', 'import', 'review', 'credit']).nullable(),
  markedAt: IsoDate.nullable(),
  offline: z.boolean(),
  distanceM: z.number().nullable(),
  markedBy: z.string().nullable(),
  revokedReason: z.string().nullable(),
});
export type FeedEntry = z.infer<typeof FeedEntry>;

export const FlagEntry = z.object({
  id: z.number().int(),
  userId: uuid.nullable(),
  fullName: z.string().nullable(),
  rollNo: z.string().nullable(),
  code: z.string(),
  detail: z.record(z.string(), z.unknown()),
  status: z.enum(['open', 'valid', 'blocked', 'dismissed']),
  at: IsoDate,
  sessionId: uuid.nullable(),
  courseCode: z.string().nullable(),
});
export type FlagEntry = z.infer<typeof FlagEntry>;

export const SessionFeed = z.object({ session: StaffSession, entries: z.array(FeedEntry), flags: z.array(FlagEntry) });
export type SessionFeed = z.infer<typeof SessionFeed>;

export const ManualBody = z.object({
  /** Idempotency key generated on the device (offline retries never double-apply). */
  clientRef: z.string().min(8).max(64),
  /** When the teacher actually took the register (server-corrected ms). */
  recordedAt: z.number().int().positive(),
  present: z.array(uuid).max(1000),
  absent: z.array(uuid).max(1000),
  note: optText(300),
  /** The teacher ticked "I have checked every name". */
  confirmed: z.literal(true),
});
export type ManualBody = z.infer<typeof ManualBody>;

export const ManualResponse = z.object({ present: z.number().int(), absent: z.number().int(), changed: z.number().int(), duplicate: z.boolean() });
export type ManualResponse = z.infer<typeof ManualResponse>;

export const ReviewBody = z.object({ action: z.enum(['valid', 'blocked', 'dismissed']) });

export const DeviceRequestItem = z.object({
  id: uuid,
  kind: z.enum(['rebind', 'reset']),
  user: z.object({ id: uuid, fullName: z.string(), rollNo: z.string().nullable(), role: z.string() }),
  from: z.object({ model: z.string(), fingerprint: z.string() }).nullable(),
  to: z.object({ model: z.string(), platform: z.string(), fingerprint: z.string() }).nullable(),
  reason: z.string(),
  createdAt: IsoDate,
});
export type DeviceRequestItem = z.infer<typeof DeviceRequestItem>;
export const DecisionBody = z.object({ decision: z.enum(['approve', 'deny']) });

export const Overview = z.object({
  role: z.enum(['teacher', 'admin']),
  liveNow: z.number().int(),
  markedToday: z.number().int(),
  flaggedOpen: z.number().int(),
  pendingRequests: z.number().int(),
  today: z.array(StaffSession),
  timezone: z.string(),
  serverTime: z.number(),
});
export type Overview = z.infer<typeof Overview>;

export const CourseReport = z.object({
  course: CourseSummary,
  minPercent: z.number(),
  held: z.number().int(),
  students: z.array(
    z.object({
      userId: uuid,
      fullName: z.string(),
      rollNo: z.string().nullable(),
      attended: z.number().int(),
      held: z.number().int(),
      percent: z.number().nullable(),
      standing: z.enum(['no-data', 'safe', 'at-risk']),
      needToReach: z.number().int(),
    }),
  ),
});
export type CourseReport = z.infer<typeof CourseReport>;

export const OkResponse = z.object({ ok: z.literal(true) });

// ───────────────────────────── student additions ─────────────────────────────

export const StudentSlot = z.object({
  weekday: z.number().int().min(0).max(6),
  start: HHMM,
  end: HHMM,
  courseId: uuid,
  courseCode: z.string(),
  courseTitle: z.string(),
  instructor: z.string().nullable(),
  room: z.string().nullable(),
  mode: SessionMode,
});
export type StudentSlot = z.infer<typeof StudentSlot>;

export const UpcomingSession = z.object({
  sessionId: uuid,
  courseId: uuid,
  courseCode: z.string(),
  courseTitle: z.string(),
  room: z.string().nullable(),
  status: SessionStatus,
  mode: SessionMode,
  scheduledStart: IsoDate,
  scheduledEnd: IsoDate,
  marked: z.boolean(),
  change: SessionChange.nullable().default(null),
});
export type UpcomingSession = z.infer<typeof UpcomingSession>;

export const TimetableResponse = z.object({ timezone: z.string(), slots: z.array(StudentSlot), upcoming: z.array(UpcomingSession) });
export type TimetableResponse = z.infer<typeof TimetableResponse>;

export const HistoryItem = z.object({
  sessionId: uuid,
  scheduledStart: IsoDate,
  lectureNo: z.number().int().nullable(),
  room: z.string().nullable(),
  status: z.enum(['present', 'absent', 'cancelled', 'upcoming', 'live']),
  source: z.enum(['scan', 'manual', 'import', 'review', 'credit']).nullable(),
  offline: z.boolean(),
  markedAt: IsoDate.nullable(),
  change: SessionChange.nullable().default(null),
  /** Counted as attended by attendance credit (medical leave, a fest…). */
  credit: z.object({ reason: z.string(), note: z.string() }).nullable().default(null),
});
export type HistoryItem = z.infer<typeof HistoryItem>;

export const SubjectDetailResponse = z.object({
  timezone: z.string(),
  minPercent: z.number(),
  subject: SubjectStat,
  remainingThisTerm: z.number().int().nullable(),
  history: z.array(HistoryItem),
});
export type SubjectDetailResponse = z.infer<typeof SubjectDetailResponse>;

// ───────────────────────────── big-screen pairing ─────────────────────────────

/** Unambiguous alphabet for codes typed by hand (no 0/O, 1/I/L). */
export const PRESENT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** What the big screen's pairing QR encodes, e.g. "ATTENDLY-TV:KXF7M2QD". */
export const PRESENT_PAIR_PREFIX = 'ATTENDLY-TV:';
/** A scanned pairing QR → its code (null if it isn't one). */
export function presentCodeFromScan(data: string): string | null {
  const t = data.trim();
  return t.toUpperCase().startsWith(PRESENT_PAIR_PREFIX) ? normalizePresentCode(t.slice(PRESENT_PAIR_PREFIX.length)) : null;
}
/** "KXF7-M2QD", "kxf7m2qd", "KXF7 M2QD" → "KXF7M2QD" (or null if it can't be a code). */
export function normalizePresentCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const c = input.toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== 8) return null;
  for (const ch of c) if (!PRESENT_CODE_ALPHABET.includes(ch)) return null;
  return c;
}
export const PresentCodeBody = z.object({ code: z.string().max(20).transform((v, ctx) => normalizePresentCode(v) ?? (ctx.addIssue({ code: 'custom', message: 'Enter the 8-character code shown on the screen' }), z.NEVER)) });

export const PresentScreen = z.object({
  id: uuid,
  device: z.string(),
  ip: z.string().nullable(),
  requestedAt: IsoDate,
  approvedAt: IsoDate.nullable(),
  approvedBy: z.string().nullable(),
});
export type PresentScreen = z.infer<typeof PresentScreen>;

// ───────────────────────────── attendance credit ─────────────────────────────

/** Why classes are counted as attended although the student wasn't there. */
export const CREDIT_REASONS = { medical: 'Medical', event: 'Fest / event', sports: 'Sports', duty: 'College duty', other: 'Other' } as const;
export const CreditReason = z.enum(['medical', 'event', 'sports', 'duty', 'other']);
export type CreditReason = z.infer<typeof CreditReason>;

export const CreditBody = z
  .object({
    /** One subject, or null for every subject the student takes. */
    courseId: uuid.nullable(),
    reason: CreditReason,
    note: z.string().trim().min(3, 'Add a short note (e.g. the certificate or the event)').max(300),
    amount: z.discriminatedUnion('kind', [
      /** This many missed classes (per subject), most recent first. */
      z.object({ kind: z.literal('classes'), classes: z.number().int().min(1).max(200) }),
      /** Missed classes worth this share of the classes held (per subject). */
      z.object({ kind: z.literal('percent'), percent: z.number().min(0.5).max(100) }),
      /** Exactly these missed classes. */
      z.object({ kind: z.literal('sessions'), sessionIds: z.array(uuid).min(1).max(300) }),
    ]),
    /** Only missed classes on these dates (e.g. the days of a medical leave). */
    from: YMD.optional(),
    to: YMD.optional(),
    /** Work out the effect without saving anything. */
    preview: z.boolean().default(false),
  })
  .refine((b) => !b.from || !b.to || b.from <= b.to, { message: 'The end date is before the start date', path: ['to'] });
export type CreditBody = z.infer<typeof CreditBody>;

export const CreditResult = z.object({
  preview: z.boolean(),
  credited: z.number().int(),
  perSubject: z.array(z.object({ courseId: uuid, code: z.string(), credited: z.number().int(), before: z.number().nullable(), after: z.number().nullable() })),
  creditId: uuid.nullable(),
});
export type CreditResult = z.infer<typeof CreditResult>;

export const CreditEntry = z.object({
  id: uuid,
  reason: CreditReason,
  note: z.string(),
  subject: z.string().nullable(),
  requested: z.string(),
  credited: z.number().int(),
  by: z.string().nullable(),
  createdAt: IsoDate,
  undone: z.boolean(),
});
export type CreditEntry = z.infer<typeof CreditEntry>;

export const MissedClass = z.object({ sessionId: uuid, courseId: uuid, code: z.string(), scheduledStart: IsoDate, lectureNo: z.number().int().nullable() });
export type MissedClass = z.infer<typeof MissedClass>;
