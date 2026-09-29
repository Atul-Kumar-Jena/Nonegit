import { z } from 'zod';

/**
 * Attendance reports. The same data feeds the on-screen view and the PDF / Excel downloads.
 *  • StudentReport — one student, every subject (optionally one subject with its class-by-class log).
 *  • MatrixReport  — many students × subjects (a batch, a subject, or the whole institution).
 */
const uuid = z.uuid();
const Standing = z.enum(['no-data', 'safe', 'at-risk']);

export const ReportHeader = z.object({
  institution: z.string(),
  termName: z.string(),
  minPercent: z.number(),
  timezone: z.string(),
  generatedAt: z.string(),
});
export type ReportHeader = z.infer<typeof ReportHeader>;

export const ReportSubject = z.object({
  courseId: uuid,
  code: z.string(),
  title: z.string(),
  instructor: z.string().nullable(),
  attended: z.number().int(),
  held: z.number().int(),
  percent: z.number().nullable(),
  standing: Standing,
});
export type ReportSubject = z.infer<typeof ReportSubject>;

export const ReportClass = z.object({
  sessionId: uuid,
  courseCode: z.string(),
  start: z.string(),
  status: z.enum(['present', 'absent', 'live']),
  how: z.string().nullable(), // "QR scan", "Register", "Manual"
});
export type ReportClass = z.infer<typeof ReportClass>;

export const StudentReport = ReportHeader.extend({
  student: z.object({ userId: uuid, fullName: z.string(), rollNo: z.string().nullable(), batches: z.array(z.string()) }),
  subjects: z.array(ReportSubject),
  total: z.object({ attended: z.number().int(), held: z.number().int(), percent: z.number().nullable(), standing: Standing }),
  /** Class-by-class log; only when one subject was asked for. */
  classes: z.array(ReportClass).nullable(),
});
export type StudentReport = z.infer<typeof StudentReport>;

export const StudentReportQuery = z.object({ courseId: uuid.optional() });

export const MatrixCell = z.object({ attended: z.number().int(), held: z.number().int() }).nullable();
export const MatrixReport = ReportHeader.extend({
  scope: z.object({ batchId: uuid.nullable(), batchName: z.string().nullable(), courseId: uuid.nullable(), label: z.string() }),
  courses: z.array(z.object({ courseId: uuid, code: z.string(), title: z.string(), instructor: z.string().nullable() })),
  students: z.array(
    z.object({
      userId: uuid,
      fullName: z.string(),
      rollNo: z.string().nullable(),
      /** One per course, in `courses` order; null = not enrolled. */
      cells: z.array(MatrixCell),
      attended: z.number().int(),
      held: z.number().int(),
      percent: z.number().nullable(),
      standing: Standing,
    }),
  ),
});
export type MatrixReport = z.infer<typeof MatrixReport>;

export const MatrixQuery = z.object({ batchId: uuid.optional(), courseId: uuid.optional() });
export type MatrixQuery = z.infer<typeof MatrixQuery>;

// ───────────────────────────── professors' punctuality ─────────────────────────────

/** How professors are doing: when they arrived for each class (log 2 vs the class time, log 1). */
export const PunctualityQuery = z.object({ days: z.coerce.number().int().min(1).max(180).default(30), teacherId: uuid.optional() });
export type PunctualityQuery = z.infer<typeof PunctualityQuery>;

export const PunctualityStatus = z.enum(['on_time', 'late', 'missed', 'cancelled']);
export type PunctualityStatus = z.infer<typeof PunctualityStatus>;

export const PunctualityReport = ReportHeader.extend({
  from: z.string(),
  to: z.string(),
  teachers: z.array(
    z.object({
      teacherId: uuid,
      name: z.string(),
      /** Classes whose time has come in the period (cancelled ones included). */
      classes: z.number().int(),
      onTime: z.number().int(),
      late: z.number().int(),
      missed: z.number().int(),
      cancelled: z.number().int(),
      /** Average minutes late, over the late classes. */
      avgLateMin: z.number().nullable(),
      /** On time out of the classes that were due (not cancelled). */
      onTimePercent: z.number().nullable(),
    }),
  ),
  classes: z.array(
    z.object({
      sessionId: uuid,
      teacherId: uuid.nullable(),
      teacher: z.string(),
      courseCode: z.string(),
      courseTitle: z.string(),
      room: z.string().nullable(),
      scheduledStart: z.string(),
      startedAt: z.string().nullable(),
      endedAt: z.string().nullable(),
      status: PunctualityStatus,
      lateMin: z.number().int().nullable(),
      substitute: z.boolean(),
    }),
  ),
});
export type PunctualityReport = z.infer<typeof PunctualityReport>;

// ───────────────────────────── analytics (charts) ─────────────────────────────

export const AnalyticsQuery = z.object({
  days: z.coerce.number().int().min(7).max(180).default(30),
  batchId: uuid.optional(),
  courseId: uuid.optional(),
});
export type AnalyticsQuery = z.infer<typeof AnalyticsQuery>;

const Share = z.object({ present: z.number().int(), expected: z.number().int(), percent: z.number().nullable() });

/** Attendance over time for a scope (institution / batch / subject; a professor's own classes). */
export const AttendanceAnalytics = ReportHeader.extend({
  scope: z.object({ label: z.string(), batchId: uuid.nullable(), courseId: uuid.nullable(), mine: z.boolean() }),
  from: z.string(),
  to: z.string(),
  /** One row per local day that had classes: classes held, marks expected (enrolled × classes) and present. */
  days: z.array(Share.extend({ date: z.string(), classes: z.number().int() })),
  total: Share.extend({ classes: z.number().int() }),
  subjects: z.array(Share.extend({ courseId: uuid, code: z.string(), title: z.string(), classes: z.number().int() })),
  /** Every active batch over the period (only without a batch filter). */
  batches: z.array(Share.extend({ batchId: uuid, name: z.string() })),
  /** Students by their percentage over the period, relative to the minimum. */
  bands: z.object({ safe: z.number().int(), near: z.number().int(), below: z.number().int(), far: z.number().int() }),
  /** Every day × batch (for the downloadable "every batch, every day" sheet). */
  batchDays: z.array(z.object({ date: z.string(), batchId: uuid, present: z.number().int(), expected: z.number().int() })),
});
export type AttendanceAnalytics = z.infer<typeof AttendanceAnalytics>;

/** A student's own trend: week by week. */
export const StudentTrend = z.object({
  minPercent: z.number(),
  weeks: z.array(z.object({ weekStart: z.string(), attended: z.number().int(), held: z.number().int(), percent: z.number().nullable() })),
});
export type StudentTrend = z.infer<typeof StudentTrend>;
