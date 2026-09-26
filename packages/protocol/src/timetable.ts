/**
 * Timetable v2 API contract: batches, drafts (drag-and-drop planner), one-off
 * adjustments, availability ("who is busy where") and notifications.
 */
import { z } from 'zod';
import { IsoDate } from './schemas';
import { DraftOp, DraftOps, OpError, PlannerConflict } from './planner';
import { RosterEntry, YMD } from './staff';

const uuid = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);

// ───────────────────────────── batches ─────────────────────────────

/** A group of students (section / class / year) that can be attached to any course. */
export const Batch = z.object({
  id: uuid,
  name: z.string(),
  active: z.boolean(),
  size: z.number().int(),
  courseIds: z.array(uuid),
});
export type Batch = z.infer<typeof Batch>;

export const BatchBody = z.object({ name: text(60), active: z.boolean().default(true) });
export const BatchUpdateBody = z.object({
  name: text(60).optional(),
  active: z.boolean().optional(),
  addMembers: z.array(uuid).max(2000).default([]),
  removeMembers: z.array(uuid).max(2000).default([]),
  /** The full set of courses this batch takes (students are enrolled / un-enrolled to match). */
  courseIds: z.array(uuid).max(100).optional(),
});
export type BatchUpdateBody = z.infer<typeof BatchUpdateBody>;
export const BatchDetail = Batch.extend({ members: z.array(RosterEntry) });
export type BatchDetail = z.infer<typeof BatchDetail>;

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
});
export type PublishResponse = z.infer<typeof PublishResponse>;

/** A teacher's (or admin's) immediate change to one class. */
export const AdjustBody = z.object({
  change: DraftOp,
  acceptWarnings: z.boolean().default(false),
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
