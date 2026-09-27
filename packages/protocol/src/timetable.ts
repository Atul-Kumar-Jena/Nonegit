/**
 * Timetable v2 API contract: batches, drafts (drag-and-drop planner), one-off
 * adjustments, availability ("who is busy where") and notifications.
 */
import { z } from 'zod';
import { IsoDate } from './schemas';
import { DraftOp, DraftOps, OpError, PlannerConflict } from './planner';
import { CourseKind, RosterEntry, YMD } from './staff';

const uuid = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);

// ───────────────────────────── batches ─────────────────────────────

/**
 * A batch (section / class) — the top of the hierarchy: department + semester → students → subjects.
 * Everyone on staff can read batches, create them, and add students and subjects to them; only an
 * admin or the teacher who created a batch can remove things from it, rename, archive or promote it.
 */
export const Batch = z.object({
  id: uuid,
  name: z.string(),
  active: z.boolean(),
  size: z.number().int(),
  courseIds: z.array(uuid),
  department: z.string().nullable().default(null),
  semester: z.number().int().nullable().default(null),
  createdBy: uuid.nullable().default(null),
  /** The professor looking after this batch: its students' phone requests go to them. */
  mentor: z.object({ id: uuid, name: z.string() }).nullable().default(null),
  /** The caller may remove students/subjects, rename, archive or change the semester. */
  canManage: z.boolean().default(false),
});
export type Batch = z.infer<typeof Batch>;

const Semester = z.number().int().min(1).max(20);
const Dept = z.string().trim().max(60).transform((s) => s || null);

export const BatchBody = z.object({
  name: text(60),
  active: z.boolean().default(true),
  department: Dept.nullable().optional(),
  semester: Semester.nullable().optional(),
});
export type BatchBody = z.infer<typeof BatchBody>;
export const BatchUpdateBody = z.object({
  name: text(60).optional(),
  active: z.boolean().optional(),
  department: Dept.nullable().optional(),
  /** Changing it moves every student of the batch to that semester. */
  semester: Semester.nullable().optional(),
  /** Mentor (a professor or admin of this institution); null removes. */
  mentorId: uuid.nullable().optional(),
  addMembers: z.array(uuid).max(2000).default([]),
  removeMembers: z.array(uuid).max(2000).default([]),
  /** The full set of courses this batch takes (students are enrolled / un-enrolled to match). */
  courseIds: z.array(uuid).max(100).optional(),
});
export type BatchUpdateBody = z.infer<typeof BatchUpdateBody>;

export const BatchCourse = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  kind: CourseKind,
  instructor: z.object({ id: uuid, name: z.string() }).nullable(),
  /** The caller teaches it (or is an admin) and can open its course page. */
  canOpen: z.boolean(),
});
export type BatchCourse = z.infer<typeof BatchCourse>;
export const BatchDetail = Batch.extend({ members: z.array(RosterEntry), courses: z.array(BatchCourse).default([]) });
export type BatchDetail = z.infer<typeof BatchDetail>;

/** Finding any student of the institution to add to a batch (names only — no contact details). */
export const StudentHit = z.object({
  userId: uuid,
  fullName: z.string(),
  rollNo: z.string().nullable(),
  department: z.string().nullable(),
  semester: z.number().int().nullable(),
  batches: z.array(z.string()),
});
export type StudentHit = z.infer<typeof StudentHit>;

/** A new subject created inside a batch (teachers become its instructor). */
export const BatchSubjectBody = z.object({
  code: text(20).transform((s) => s.toUpperCase()),
  title: text(120),
  kind: CourseKind.default('theory'),
  instructorId: uuid.nullable().optional(),
});
export type BatchSubjectBody = z.infer<typeof BatchSubjectBody>;

// ───────────────────────────── drafts ─────────────────────────────

export const DraftSummary = z.object({
  id: uuid,
  title: z.string(),
  weekStart: YMD,
  status: z.enum(['draft', 'published', 'discarded']),
  version: z.number().int(),
  once: z.number().int(),
  weekly: z.number().int(),
  updatedAt: IsoDate,
  updatedBy: z.string().nullable(),
  publishedAt: IsoDate.nullable(),
});
export type DraftSummary = z.infer<typeof DraftSummary>;
export const Draft = DraftSummary.extend({ ops: DraftOps, note: z.string().nullable() });
export type Draft = z.infer<typeof Draft>;

export const CreateDraftBody = z.object({ title: text(80), weekStart: YMD });
export const SaveDraftBody = z.object({ version: z.number().int().positive(), ops: DraftOps, title: text(80).optional() });
export const PublishBody = z.object({
  version: z.number().int().positive(),
  /** The admin saw the "students have two classes at once" warnings and publishes anyway. */
  acceptWarnings: z.boolean().default(false),
  note: z.string().trim().max(300).optional(),
});

/** Result of publishing a draft or one adjustment. Nothing is changed unless `published` is true. */
export const PublishResponse = z.object({
  published: z.boolean(),
  applied: z.number().int(),
  notified: z.number().int(),
  conflicts: z.array(PlannerConflict),
  errors: z.array(OpError),
  /** Substitutions sent to teachers for approval (they apply when accepted). */
  requested: z.number().int().default(0),
});
export type PublishResponse = z.infer<typeof PublishResponse>;

/** A teacher's (or admin's) immediate change to one class. */
export const AdjustBody = z.object({
  change: DraftOp,
  acceptWarnings: z.boolean().default(false),
  /** A note for the students (shown on the class and in their notification). */
  note: z.string().trim().max(300).optional(),
});
export type AdjustBody = z.infer<typeof AdjustBody>;

// ───────────────────────────── availability ─────────────────────────────

export const BusyBlock = z.object({
  sessionId: uuid,
  courseId: uuid,
  courseCode: z.string(),
  courseTitle: z.string(),
  date: YMD,
  start: z.string(),
  end: z.string(),
  room: z.string().nullable(),
  substitute: z.boolean(),
  status: z.string(),
});
export type BusyBlock = z.infer<typeof BusyBlock>;
export const Availability = z.object({
  from: YMD,
  days: z.number().int(),
  timezone: z.string(),
  teachers: z.array(z.object({ id: uuid, name: z.string(), role: z.string(), busy: z.array(BusyBlock) })),
  rooms: z.array(z.object({ id: uuid, name: z.string(), busy: z.array(BusyBlock) })),
});
export type Availability = z.infer<typeof Availability>;

// ───────────────────────────── notifications ─────────────────────────────

export const AppNotification = z.object({
  id: z.number().int(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: IsoDate,
  read: z.boolean(),
});
export type AppNotification = z.infer<typeof AppNotification>;
export const NotificationsResponse = z.object({ items: z.array(AppNotification), unread: z.number().int() });
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;
export const ReadNotificationsBody = z.object({ ids: z.array(z.number().int().positive()).max(500).default([]), all: z.boolean().default(false) });
