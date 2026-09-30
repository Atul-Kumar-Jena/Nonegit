/**
 * Requests between people about one class:
 *  • cover: an admin (or the class's own teacher) asks another teacher to take a class.
 *    Nothing changes until that teacher accepts; then the students are notified.
 *  • student: a student asks their teacher about a class (move it, an extra class…);
 *    the teacher replies, and can then adjust the class.
 */
import { z } from 'zod';
import { IsoDate, Role } from './schemas';
import { OpError, PlannerConflict } from './planner';

const uuid = z.uuid();
export const RequestNote = z.string().trim().max(300);

export const CoverRequestBody = z.object({
  sessionId: uuid,
  teacherId: uuid,
  noteToTeacher: RequestNote.optional(),
  noteToStudents: RequestNote.optional(),
  /** The admin saw a "students have another class then" warning and goes ahead. */
  acceptWarnings: z.boolean().default(false),
  /**
   * 'assign': the class is theirs at once and the students are told now (with the note);
   * 'ask': the teacher accepts first, and only then are the students told.
   */
  mode: z.enum(['assign', 'ask']).default('ask'),
});
export type CoverRequestBody = z.infer<typeof CoverRequestBody>;

export const StudentRequestTopic = z.enum(['reschedule', 'extra', 'cancel', 'doubt', 'other']);
export type StudentRequestTopic = z.infer<typeof StudentRequestTopic>;
export const STUDENT_TOPIC_LABELS: Record<StudentRequestTopic, string> = {
  reschedule: 'Please move this class',
  extra: 'Please hold an extra class',
  cancel: 'Please cancel this class',
  doubt: 'A question about this class',
  other: 'Something else',
};

export const StudentRequestBody = z.object({
  sessionId: uuid,
  topic: StudentRequestTopic,
  note: z.string().trim().min(3, 'Write a few words for your teacher').max(500),
});
export type StudentRequestBody = z.infer<typeof StudentRequestBody>;

export const ReplyBody = z.object({
  reply: RequestNote.optional(),
  acceptWarnings: z.boolean().default(false),
});
export type ReplyBody = z.infer<typeof ReplyBody>;

export const RequestStatus = z.enum(['pending', 'accepted', 'declined', 'cancelled', 'expired']);
export type RequestStatus = z.infer<typeof RequestStatus>;

export const ChangeRequest = z.object({
  id: uuid,
  kind: z.enum(['cover', 'student']),
  topic: z.enum(['cover', 'reschedule', 'extra', 'cancel', 'doubt', 'other']),
  status: RequestStatus,
  createdAt: IsoDate,
  decidedAt: IsoDate.nullable(),
  noteToTeacher: z.string().nullable(),
  noteToStudents: z.string().nullable(),
  reply: z.string().nullable(),
  from: z.object({ id: uuid, name: z.string(), role: Role, rollNo: z.string().nullable() }),
  to: z.object({ id: uuid, name: z.string() }),
  session: z.object({
    id: uuid,
    courseId: uuid,
    courseCode: z.string(),
    courseTitle: z.string(),
    start: IsoDate,
    end: IsoDate,
    room: z.string().nullable(),
    status: z.string(),
    teacher: z.string().nullable(),
  }),
});
export type ChangeRequest = z.infer<typeof ChangeRequest>;

export const RequestsResponse = z.object({
  incoming: z.array(ChangeRequest),
  outgoing: z.array(ChangeRequest),
});
export type RequestsResponse = z.infer<typeof RequestsResponse>;

export const CoverResponse = z.object({
  /** sent: waiting for the teacher · applied: done at once (you took it yourself) · refused: see conflicts/errors. */
  status: z.enum(['sent', 'applied', 'refused']),
  request: ChangeRequest.nullable(),
  conflicts: z.array(PlannerConflict),
  errors: z.array(OpError),
  notified: z.number().int(),
});
export type CoverResponse = z.infer<typeof CoverResponse>;

/** Result of accepting a request: for a cover, the class change is published. */
export const DecisionResponse = z.object({
  request: ChangeRequest,
  conflicts: z.array(PlannerConflict),
  errors: z.array(OpError),
  notified: z.number().int(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;
