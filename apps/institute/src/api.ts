/**
 * Typed wrappers for the staff API. Every call is signed by the device key and
 * every response is validated against the shared contract before use.
 */
import { z } from 'zod';
import {
  AuthenticatorSetup,
  Colleague,
  AuthenticatorStatus,
  ChangeRequest,
  CoverResponse,
  DecisionResponse,
  RequestsResponse,
  type CoverRequestBody,
  Availability,
  Batch,
  BatchDetail,
  Draft,
  DraftSummary,
  PlannerWeek,
  PublishResponse,
  type BatchUpdateBody,
  type StaffAccessBody,
  type BatchBody,
  type BatchSubjectBody,
  StudentHit,
  type DraftOp,
  BulkImportResponse,
  CourseReport,
  MatrixReport,
  StudentReport,
  CourseSummary,
  DeviceRequestItem,
  FlagEntry,
  InstitutionSettings,
  ManualResponse,
  OfflinePack,
  OkResponse,
  PresentScreen,
  Overview,
  Person,
  Room,
  RosterEntry,
  SessionFeed,
  SessionWithSecret,
  Slot,
  StaffMe,
  StaffSession,
  type CourseBody,
  type CreateSessionBody,
  type EndSessionBody,
  type EnrollmentBody,
  type ManualBody,
  type PersonBody,
  type PersonUpdateBody,
  type RoomBody,
  type SlotBody,
  type StartSessionBody,
  type UpdateInstitutionBody,
} from '@attendly/protocol';
import type { ApiClient } from '@kit/lib/api-core';

const enc = encodeURIComponent;
const qs = (o: Record<string, string | number | undefined | null>) => {
  const parts = Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

export const staffApi = {
  colleagues: (api: ApiClient) => api.authed('GET', '/v1/staff/colleagues', z.array(Colleague)),
  me: (api: ApiClient) => api.authed('GET', '/v1/staff/me', StaffMe),
  overview: (api: ApiClient) => api.authed('GET', '/v1/staff/overview', Overview),

  institution: (api: ApiClient) => api.authed('GET', '/v1/staff/institution', InstitutionSettings),
  updateInstitution: (api: ApiClient, b: UpdateInstitutionBody) => api.authed('POST', '/v1/staff/institution', InstitutionSettings, b),

  rooms: (api: ApiClient) => api.authed('GET', '/v1/staff/rooms', z.array(Room)),
  saveRoom: (api: ApiClient, id: string | null, b: RoomBody) => api.authed('POST', id ? `/v1/staff/rooms/${enc(id)}` : '/v1/staff/rooms', Room, b),

  people: (api: ApiClient, f: { role?: string; q?: string; courseId?: string } = {}) => api.authed('GET', `/v1/staff/people${qs(f)}`, z.array(Person)),
  person: (api: ApiClient, id: string) => api.authed('GET', `/v1/staff/people/${enc(id)}`, Person),
  createPerson: (api: ApiClient, b: PersonBody) => api.authed('POST', '/v1/staff/people', Person, b),
  /** Admins: admin ↔ professor, and a professor's extra powers. */
  setAccess: (api: ApiClient, id: string, b: StaffAccessBody) => api.authed('POST', `/v1/staff/people/${enc(id)}/access`, Person, b),
  updatePerson: (api: ApiClient, id: string, b: PersonUpdateBody) => api.authed('POST', `/v1/staff/people/${enc(id)}`, Person, b),
  importPeople: (api: ApiClient, rows: unknown[], courseIds: string[], batchId?: string | null) =>
    api.authed('POST', '/v1/staff/people/import', BulkImportResponse, { rows, courseIds, ...(batchId ? { batchId } : {}) }),

  courses: (api: ApiClient) => api.authed('GET', '/v1/staff/courses', z.array(CourseSummary)),
  saveCourse: (api: ApiClient, id: string | null, b: CourseBody) => api.authed('POST', id ? `/v1/staff/courses/${enc(id)}` : '/v1/staff/courses', CourseSummary, b),
  roster: (api: ApiClient, courseId: string) => api.authed('GET', `/v1/staff/courses/${enc(courseId)}/roster`, z.array(RosterEntry)),
  enroll: (api: ApiClient, courseId: string, b: EnrollmentBody) => api.authed('POST', `/v1/staff/courses/${enc(courseId)}/enrollments`, z.array(RosterEntry), b),
  report: (api: ApiClient, courseId: string) => api.authed('GET', `/v1/staff/courses/${enc(courseId)}/report`, CourseReport),
  /** Any student's attendance (every teacher can read it). */
  studentReport: (api: ApiClient, userId: string, courseId?: string) => api.authed('GET', `/v1/staff/students/${enc(userId)}/report${qs({ courseId })}`, StudentReport),
  /** Students × subjects for a batch / subject / everyone. */
  matrix: (api: ApiClient, f: { batchId?: string; courseId?: string }) => api.authed('GET', `/v1/staff/reports/matrix${qs(f)}`, MatrixReport),
  courseSessions: (api: ApiClient, courseId: string) => api.authed('GET', `/v1/staff/courses/${enc(courseId)}/sessions`, z.array(StaffSession)),

  timetable: (api: ApiClient) => api.authed('GET', '/v1/staff/timetable', z.array(Slot)),
  saveSlot: (api: ApiClient, id: string | null, b: SlotBody) => api.authed('POST', id ? `/v1/staff/timetable/${enc(id)}` : '/v1/staff/timetable', Slot, b),
  deleteSlot: (api: ApiClient, id: string) => api.authed('POST', `/v1/staff/timetable/${enc(id)}/delete`, OkResponse, {}),

  sessions: (api: ApiClient, f: { date?: string; days?: number; courseId?: string } = {}) => api.authed('GET', `/v1/staff/sessions${qs(f)}`, z.array(StaffSession)),
  createSession: (api: ApiClient, b: CreateSessionBody) => api.authed('POST', '/v1/staff/sessions', StaffSession, b),
  session: (api: ApiClient, id: string) => api.authed('GET', `/v1/staff/sessions/${enc(id)}`, SessionWithSecret),
  showing: (api: ApiClient, id: string) => api.authed('POST', `/v1/staff/sessions/${enc(id)}/showing`, OkResponse, {}),
  start: (api: ApiClient, id: string, b: StartSessionBody) => api.authed('POST', `/v1/staff/sessions/${enc(id)}/start`, SessionWithSecret, b),
  end: (api: ApiClient, id: string, b: EndSessionBody) => api.authed('POST', `/v1/staff/sessions/${enc(id)}/end`, StaffSession, b),
  cancel: (api: ApiClient, id: string, reason?: string) => api.authed('POST', `/v1/staff/sessions/${enc(id)}/cancel`, StaffSession, reason ? { reason } : {}),
  adjust: (api: ApiClient, id: string, change: DraftOp, acceptWarnings = false, note?: string) =>
    api.authed('POST', `/v1/staff/sessions/${enc(id)}/adjust`, PublishResponse, { change, acceptWarnings, ...(note ? { note } : {}) }),
  coverRequest: (api: ApiClient, b: CoverRequestBody) => api.authed('POST', '/v1/staff/cover-requests', CoverResponse, b),
  requests: (api: ApiClient) => api.authed('GET', '/v1/staff/requests', RequestsResponse),
  acceptRequest: (api: ApiClient, id: string, reply?: string, acceptWarnings = false) =>
    api.authed('POST', `/v1/staff/requests/${enc(id)}/accept`, DecisionResponse, { acceptWarnings, ...(reply ? { reply } : {}) }),
  declineRequest: (api: ApiClient, id: string, reply?: string) => api.authed('POST', `/v1/staff/requests/${enc(id)}/decline`, DecisionResponse, reply ? { reply } : {}),
  issueAuthenticator: (api: ApiClient, personId: string) => api.authed('POST', `/v1/staff/people/${enc(personId)}/authenticator`, AuthenticatorSetup, {}),
  removeAuthenticator: (api: ApiClient, personId: string) => api.authed('POST', `/v1/staff/people/${enc(personId)}/authenticator/remove`, AuthenticatorStatus, {}),
  cancelRequest: (api: ApiClient, id: string) => api.authed('POST', `/v1/staff/requests/${enc(id)}/cancel`, ChangeRequest, {}),
  availability: (api: ApiClient, date: string, days = 1) => api.authed('GET', `/v1/staff/availability${qs({ date, days })}`, Availability),

  batches: (api: ApiClient) => api.authed('GET', '/v1/staff/batches', z.array(Batch)),
  batch: (api: ApiClient, id: string) => api.authed('GET', `/v1/staff/batches/${enc(id)}`, BatchDetail),
  createBatch: (api: ApiClient, b: BatchBody) => api.authed('POST', '/v1/staff/batches', Batch, b),
  /** Creates a new subject inside a batch (a teacher becomes its instructor). */
  batchSubject: (api: ApiClient, id: string, b: BatchSubjectBody) => api.authed('POST', `/v1/staff/batches/${enc(id)}/subjects`, BatchDetail, b),
  searchStudents: (api: ApiClient, q: string, notInBatch?: string) => api.authed('GET', `/v1/staff/students/search${qs({ q, notInBatch })}`, z.array(StudentHit)),
  /** Every subject of the institution (read-only list). */
  allCourses: (api: ApiClient) => api.authed('GET', '/v1/staff/courses?scope=all', z.array(CourseSummary)),
  updateBatch: (api: ApiClient, id: string, b: Partial<BatchUpdateBody>) => api.authed('POST', `/v1/staff/batches/${enc(id)}`, BatchDetail, b),

  plannerWeek: (api: ApiClient, week: string) => api.authed('GET', `/v1/staff/planner${qs({ week })}`, PlannerWeek),
  drafts: (api: ApiClient) => api.authed('GET', '/v1/staff/drafts', z.array(DraftSummary)),
  draft: (api: ApiClient, id: string) => api.authed('GET', `/v1/staff/drafts/${enc(id)}`, Draft),
  createDraft: (api: ApiClient, title: string, weekStart: string) => api.authed('POST', '/v1/staff/drafts', Draft, { title, weekStart }),
  saveDraft: (api: ApiClient, id: string, version: number, ops: DraftOp[], title?: string) =>
    api.authed('POST', `/v1/staff/drafts/${enc(id)}`, Draft, { version, ops, ...(title ? { title } : {}) }),
  checkDraft: (api: ApiClient, id: string) => api.authed('POST', `/v1/staff/drafts/${enc(id)}/check`, PublishResponse, {}),
  publishDraft: (api: ApiClient, id: string, version: number, acceptWarnings: boolean, note?: string) =>
    api.authed('POST', `/v1/staff/drafts/${enc(id)}/publish`, PublishResponse, { version, acceptWarnings, ...(note ? { note } : {}) }),
  discardDraft: (api: ApiClient, id: string) => api.authed('POST', `/v1/staff/drafts/${enc(id)}/discard`, DraftSummary, {}),
  feed: (api: ApiClient, id: string) => api.authed('GET', `/v1/staff/sessions/${enc(id)}/feed`, SessionFeed),
  register: (api: ApiClient, id: string, b: ManualBody) => api.authed('POST', `/v1/staff/sessions/${enc(id)}/register`, ManualResponse, b),
  offlinePack: (api: ApiClient) => api.authed('GET', '/v1/staff/offline-pack', OfflinePack),

  presentLookup: (api: ApiClient, code: string) => api.authed('POST', '/v1/staff/present/lookup', PresentScreen, { code }),
  screens: (api: ApiClient, sessionId: string) => api.authed('GET', `/v1/staff/sessions/${enc(sessionId)}/screens`, z.array(PresentScreen)),
  connectScreen: (api: ApiClient, sessionId: string, code: string) => api.authed('POST', `/v1/staff/sessions/${enc(sessionId)}/screens`, z.array(PresentScreen), { code }),
  disconnectScreen: (api: ApiClient, sessionId: string, pairingId: string) =>
    api.authed('POST', `/v1/staff/sessions/${enc(sessionId)}/screens/${enc(pairingId)}/disconnect`, z.array(PresentScreen), {}),

  flags: (api: ApiClient, status?: string) => api.authed('GET', `/v1/staff/flags${qs({ status })}`, z.array(FlagEntry)),
  reviewFlag: (api: ApiClient, id: number, action: 'valid' | 'blocked' | 'dismissed') => api.authed('POST', `/v1/staff/flags/${id}`, FlagEntry, { action }),
  deviceRequests: (api: ApiClient) => api.authed('GET', '/v1/staff/device-requests', z.array(DeviceRequestItem)),
  decide: (api: ApiClient, id: string, decision: 'approve' | 'deny') => api.authed('POST', `/v1/staff/device-requests/${enc(id)}`, OkResponse, { decision }),
};
