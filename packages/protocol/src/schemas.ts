/**
 * API contract — zod schemas used by the server to validate requests and by
 * clients to validate responses. One source of truth, so the apps and the
 * server can never silently disagree about a payload.
 */
import { z } from 'zod';
import { isB64urlOfLength } from './encoding';
import { QR_MAX_LENGTH } from './qr';

export const API_VERSION = 1;

const b64url = (bytes: number, label: string) =>
  z.string().refine((s) => isB64urlOfLength(s, bytes), { message: `${label} must be ${bytes} bytes of base64url` });

export const PublicKeyB64 = b64url(32, 'publicKey');
export const SignatureB64 = b64url(64, 'signature');
/** Opaque bearer secrets: 32 random bytes, base64url. */
export const OpaqueToken = b64url(32, 'token');
export const IsoDate = z.string().datetime({ offset: true });

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const Channel = z.enum(['email', 'phone']);
export type Channel = z.infer<typeof Channel>;

export const Platform = z.enum(['ios', 'android', 'web']);
export type Platform = z.infer<typeof Platform>;

export const Role = z.enum(['student', 'teacher', 'admin', 'developer']);
export type Role = z.infer<typeof Role>;

// ───────────────────────────── meta ─────────────────────────────

export const MetaResponse = z.object({
  name: z.string(),
  apiVersion: z.number().int(),
  serverTime: z.number(),
  serverKey: z.object({ kid: z.string(), publicKey: PublicKeyB64 }),
  minAppVersion: z.string(),
  /** Sign-in channels this server can deliver codes over. */
  channels: z.array(z.enum(['email', 'phone'])).min(1),
  /** Present only on a demo server: sign-in codes are skipped, and these accounts can be tapped to sign in. */
  demo: z
    .object({
      instantLogin: z.boolean(),
      institution: z.string().nullable(),
      /** The demo institute's code, for the Institute app's "Try the demo" button. */
      institutionCode: z.string().nullable().default(null),
      accounts: z.array(z.object({ role: Role, name: z.string(), email: z.string(), title: z.string() })).max(40),
    })
    .nullable()
    .default(null),
});
export type MetaResponse = z.infer<typeof MetaResponse>;

// ───────────────────────────── auth ─────────────────────────────

export const EmailIdentifier = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** E.164 phone number, e.g. +919876543210 */
export const PhoneIdentifier = z.string().trim().regex(/^\+[1-9][0-9]{7,14}$/, 'Phone must be in +<country><number> format');

/** "7f3a-91c2", "7F3A91C2", "7F3A 91C2" → "7F3A91C2" (null if it can't be a code). */
export function normalizeInstitutionCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const c = input.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{8}$/.test(c) ? c : null;
}
/** "7F3A91C2" → "7F3A-91C2" */
export const formatInstitutionCode = (c: string) => (c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);
const InstitutionCode = z.string().max(20).transform((v, ctx) => normalizeInstitutionCode(v) ?? (ctx.addIssue({ code: 'custom', message: 'An institution code has 8 letters and digits, e.g. 7F3A-91C2' }), z.NEVER));

export const OtpRequestBody = z.discriminatedUnion('channel', [
  /** institutionCode (Institute app): only accounts of that institution can get a code. */
  z.object({ channel: z.literal('email'), identifier: EmailIdentifier, institutionCode: InstitutionCode.optional() }),
  z.object({ channel: z.literal('phone'), identifier: PhoneIdentifier, institutionCode: InstitutionCode.optional() }),
]);

export const InstitutionLookup = z.object({
  code: z.string(),
  name: z.string(),
  verified: z.boolean(),
  /** Suspended institutions can't be used. */
  active: z.boolean(),
});
export type InstitutionLookup = z.infer<typeof InstitutionLookup>;
export const InstitutionLookupQuery = z.object({ code: InstitutionCode });
export type OtpRequestBody = z.infer<typeof OtpRequestBody>;

export const OtpRequestResponse = z.object({
  challengeId: z.uuid(),
  expiresAt: IsoDate,
  resendAfterSec: z.number().int().nonnegative(),
  destination: z.string(),
  /** Where the code comes from: an email/SMS we send, or the person's authenticator app. */
  method: z.enum(['email', 'authenticator']).default('email'),
  /** Demo servers only: the code itself, so the app can sign straight in without asking for it. */
  instantCode: z.string().regex(/^[0-9]{6}$/).optional(),
});
export type OtpRequestResponse = z.infer<typeof OtpRequestResponse>;

export const DeviceInfo = z.object({
  publicKey: PublicKeyB64,
  platform: Platform,
  model: shortText(80),
  osVersion: shortText(40),
  appVersion: shortText(20),
  integrity: z.object({ rooted: z.boolean(), emulator: z.boolean() }),
  /** The phone's hardware ID (Android ID / iOS vendor ID): survives clearing the app's data. Stored only as a keyed hash. */
  hardwareId: z.string().trim().min(4).max(128).optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const OtpVerifyBody = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^[0-9]{6}$/, 'Code must be 6 digits'),
  device: DeviceInfo,
  proof: SignatureB64,
});
export type OtpVerifyBody = z.infer<typeof OtpVerifyBody>;

export const AuthTokens = z.object({
  accessToken: OpaqueToken,
  accessExpiresAt: IsoDate,
  refreshToken: OpaqueToken,
  refreshExpiresAt: IsoDate,
});
export type AuthTokens = z.infer<typeof AuthTokens>;

export const UserSummary = z.object({
  id: z.uuid(),
  role: Role,
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  rollNo: z.string().nullable(),
  department: z.string().nullable(),
  semester: z.number().int().nullable(),
  institution: z.object({ slug: z.string(), name: z.string(), code: z.string().default('') }),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const DeviceSummary = z.object({
  id: z.uuid(),
  platform: Platform,
  model: z.string(),
  osVersion: z.string(),
  fingerprint: z.string(),
  status: z.enum(['active', 'revoked']),
  boundAt: IsoDate.nullable(),
  lastSeenAt: IsoDate.nullable(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

export const OtpVerifyResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), auth: AuthTokens, user: UserSummary, device: DeviceSummary }),
  z.object({ status: z.literal('bind_required'), ticket: OpaqueToken, user: UserSummary }),
  z.object({
    status: z.literal('device_mismatch'),
    ticket: OpaqueToken,
    user: UserSummary,
    boundDevice: z.object({ model: z.string(), platform: Platform, fingerprint: z.string(), boundAt: IsoDate.nullable() }),
    pendingRequest: z.object({ id: z.uuid(), createdAt: IsoDate }).nullable(),
  }),
]);
export type OtpVerifyResponse = z.infer<typeof OtpVerifyResponse>;

export const BindBody = z.object({ ticket: OpaqueToken, proof: SignatureB64 });
export type BindBody = z.infer<typeof BindBody>;

export const BindResponse = z.object({ auth: AuthTokens, user: UserSummary, device: DeviceSummary });
export type BindResponse = z.infer<typeof BindResponse>;

export const RebindRequestBody = z.object({ ticket: OpaqueToken, proof: SignatureB64, reason: z.string().trim().min(3).max(200) });
export type RebindRequestBody = z.infer<typeof RebindRequestBody>;

export const DeviceRequestResponse = z.object({ requestId: z.uuid(), status: z.enum(['pending', 'approved', 'denied', 'cancelled']) });
export type DeviceRequestResponse = z.infer<typeof DeviceRequestResponse>;

export const RefreshBody = z.object({ refreshToken: OpaqueToken });
export type RefreshBody = z.infer<typeof RefreshBody>;

// ───────────────────────────── student data ─────────────────────────────

export const SessionStatus = z.enum(['scheduled', 'live', 'closed', 'cancelled']);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** What changed about a class after the timetable was set (shown to students and teachers). */
export const SessionChange = z.object({
  kind: z.enum(['rescheduled', 'substitute', 'extra', 'cancelled']),
  note: z.string().nullable(),
  originalStart: IsoDate.nullable(),
  teacher: z.string().nullable(),
});
export type SessionChange = z.infer<typeof SessionChange>;

export const TodaySession = z.object({
  sessionId: z.uuid(),
  courseCode: z.string(),
  courseTitle: z.string(),
  room: z.string().nullable(),
  status: SessionStatus,
  mode: z.enum(['qr', 'manual']).default('qr'),
  scheduledStart: IsoDate,
  scheduledEnd: IsoDate,
  marked: z.boolean(),
  change: SessionChange.nullable().default(null),
});
export type TodaySession = z.infer<typeof TodaySession>;

export const DashboardResponse = z.object({
  user: UserSummary,
  device: DeviceSummary,
  term: z.object({
    name: z.string(),
    attended: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
    percent: z.number().nullable(),
    weekDelta: z.number().nullable(),
    minPercent: z.number(),
  }),
  today: z.array(TodaySession),
  timezone: z.string(),
  serverTime: z.number(),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

export const SubjectStat = z.object({
  courseId: z.uuid(),
  code: z.string(),
  title: z.string(),
  kind: z.enum(['theory', 'lab']),
  instructor: z.string().nullable(),
  attended: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  percent: z.number().nullable(),
  standing: z.enum(['no-data', 'safe', 'at-risk']),
  needToReach: z.number().int().nonnegative(),
  safeToMiss: z.number().int().nonnegative(),
});
export type SubjectStat = z.infer<typeof SubjectStat>;

export const SubjectsResponse = z.object({
  termName: z.string(),
  termWeek: z.number().int().positive(),
  minPercent: z.number(),
  subjects: z.array(SubjectStat),
});
export type SubjectsResponse = z.infer<typeof SubjectsResponse>;

export const ProfileResponse = z.object({
  user: UserSummary,
  device: DeviceSummary,
  lastScanAt: IsoDate.nullable(),
  resetRequests: z.object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    pending: z.object({ id: z.uuid(), createdAt: IsoDate, reason: z.string() }).nullable(),
  }),
});
export type ProfileResponse = z.infer<typeof ProfileResponse>;

export const ResetRequestBody = z.object({ reason: z.string().trim().min(3).max(200) });
export type ResetRequestBody = z.infer<typeof ResetRequestBody>;

// ───────────────────────────── attendance ─────────────────────────────

export const MarkBody = z.object({
  qr: z.string().min(1).max(QR_MAX_LENGTH),
  /**
   * When the code was scanned (server-corrected ms). Only differs from "now" for
   * scans captured offline and uploaded later.
   */
  scannedAt: z.number().int().positive().optional(),
  location: z.object({
    lat: z.number().gte(-90).lte(90),
    lng: z.number().gte(-180).lte(180),
    accuracyM: z.number().nonnegative().max(100_000),
    mocked: z.boolean(),
    capturedAt: z.number().int().positive(),
  }),
});
export type MarkBody = z.infer<typeof MarkBody>;

export const MarkResponse = z.object({
  status: z.literal('present'),
  alreadyMarked: z.boolean(),
  record: z.object({
    id: z.uuid(),
    sessionId: z.uuid(),
    offline: z.boolean(),
    sessionCode: z.string(),
    lectureNo: z.number().int().nullable(),
    courseCode: z.string(),
    courseTitle: z.string(),
    kind: z.enum(['theory', 'lab']),
    markedAt: IsoDate,
    qrSeq: z.number().int().nonnegative(),
    distanceM: z.number().nonnegative(),
  }),
  receipt: z.object({
    userId: z.uuid(),
    deviceFingerprint: z.string(),
    serverKeyId: z.string(),
    signature: SignatureB64,
  }),
  course: z.object({ before: z.number().nullable(), after: z.number().nullable() }),
});
export type MarkResponse = z.infer<typeof MarkResponse>;

// ───────────────────────────── authenticator app ─────────────────────────────

/** A new authenticator secret to add to Google Authenticator (scan the QR, open the link, or type the key). */
export const AuthenticatorSetup = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  issuer: z.string(),
  account: z.string(),
  /** Admin-issued setups are live at once; self-service ones wait for the first code. */
  active: z.boolean(),
});
export type AuthenticatorSetup = z.infer<typeof AuthenticatorSetup>;
export const AuthenticatorStatus = z.object({ enabled: z.boolean(), enabledAt: IsoDate.nullable() });
export type AuthenticatorStatus = z.infer<typeof AuthenticatorStatus>;
export const AuthenticatorCodeBody = z.object({ code: z.string().regex(/^[0-9]{6}$/, 'Enter the 6-digit code') });
export type AuthenticatorCodeBody = z.infer<typeof AuthenticatorCodeBody>;
