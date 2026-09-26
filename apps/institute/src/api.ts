/**
 * Typed wrappers for the staff API. Every call is signed by the device key and
 * every response is validated against the shared contract before use.
 */
import { z } from 'zod';
import {
  BulkImportResponse,
  CourseReport,
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
  me: (api: ApiClient) => api.authed('GET', '/v1/staff/me', StaffMe),
  overview: (api: ApiClient) => api.authed('GET', '/v1/staff/overview', Overview),

  institution: (api: ApiClient) => api.authed('GET', '/v1/staff/institution', InstitutionSettings),
  updateInstitution: (api: ApiClient, b: UpdateInstitutionBody) => api.authed('POST', '/v1/staff/institution', InstitutionSettings, b),

  rooms: (api: ApiClient) => api.authed('GET', '/v1/staff/rooms', z.array(Room)),
  saveRoom: (api: ApiClient, id: string | null, b: RoomBody) => api.authed('POST', id ? `/v1/staff/rooms/${enc(id)}` : '/v1/staff/rooms', Room, b),

  people: (api: ApiClient, f: { role?: string; q?: string; courseId?: string } = {}) => api.authed('GET', `/v1/staff/people${qs(f)}`, z.array(Person)),
  person: (api: ApiClient, id: string) => api.authed('GET', `/v1/staff/people/${enc(id)}`, Person),
  createPerson: (api: ApiClient, b: PersonBody) => api.authed('POST', '/v1/staff/people', Person, b),
  updatePerson: (api: ApiClient, id: string, b: PersonUpdateBody) => api.authed('POST', `/v1/staff/people/${enc(id)}`, Person, b),
  importPeople: (api: ApiClient, rows: unknown[], courseIds: string[]) => api.authed('POST', '/v1/staff/people/import', BulkImportResponse, { rows, courseIds }),

  courses: (api: ApiClient) => api.authed('GET', '/v1/staff/courses', z.array(CourseSummary)),
  saveCourse: (api: ApiClient, id: string | null, b: CourseBody) => api.authed('POST', id ? `/v1/staff/courses/${enc(id)}` : '/v1/staff/courses', CourseSummary, b),
  roster: (api: ApiClient, courseId: string) => api.authed('GET', `/v1/staff/courses/${enc(courseId)}/roster`, z.array(RosterEntry)),
  enroll: (api: ApiClient, courseId: string, b: EnrollmentBody) => api.authed('POST', `/v1/staff/courses/${enc(courseId)}/enrollments`, z.array(RosterEntry), b),
  report: (api: ApiClient, courseId: string) => api.authed('GET', `/v1/staff/courses/${enc(courseId)}/report`, CourseReport),
  courseSessions: (api: ApiClient, courseId: string) => api.authed('GET', `/v1/staff/courses/${enc(courseId)}/sessions`, z.array(StaffSession)),

  timetable: (api: ApiClient) => api.authed('GET', '/v1/staff/timetable', z.array(Slot)),
  saveSlot: (api: ApiClient, id: string | null, b: SlotBody) => api.authed('POST', id ? `/v1/staff/timetable/${enc(id)}` : '/v1/staff/timetable', Slot, b),
  deleteSlot: (api: ApiClient, id: string) => api.authed('POST', `/v1/staff/timetable/${enc(id)}/delete`, OkResponse, {}),

  sessions: (api: ApiClient, f: { date?: string; days?: number; courseId?: string } = {}) => api.authed('GET', `/v1/staff/sessions${qs(f)}`, z.array(StaffSession)),
  createSession: (api: ApiClient, b: CreateSessionBody) => api.authed('POST', '/v1/staff/sessions', StaffSession, b),
  session: (api: ApiClient, id: string) => api.authed('GET', `/v1/staff/sessions/${enc(id)}`, SessionWithSecret),
  start: (api: ApiClient, id: string, b: StartSessionBody) => api.authed('POST', `/v1/staff/sessions/${enc(id)}/start`, SessionWithSecret, b),
  end: (api: ApiClient, id: string, b: EndSessionBody) => api.authed('POST', `/v1/staff/sessions/${enc(id)}/end`, StaffSession, b),
  cancel: (api: ApiClient, id: string) => api.authed('POST', `/v1/staff/sessions/${enc(id)}/cancel`, StaffSession, {}),
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
