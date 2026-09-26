/**
 * Every error the API can return has a stable machine code and a
 * human-readable title/hint, shared by all apps so the UI never has to guess.
 */

/** Reasons a scan (attendance mark) can be refused. */
export const REJECTION_CODES = {
  'E-EXPIRED': { title: 'QR token expired', hint: 'The code rotated before it reached the server. Scan the live code again.', suspicious: false },
  'E-QR-INVALID': { title: 'Invalid QR code', hint: 'This is not a valid Attendly session code. Scan the code shown by your instructor.', suspicious: true },
  'E-SESSION-CLOSED': { title: 'Session not live', hint: 'This session has not started yet or has already ended.', suspicious: false },
  'E-NOT-STARTED': { title: 'Class not started yet', hint: 'Your instructor has not started this class. Scan again once the live code is on screen.', suspicious: false },
  'E-NOT-ENROLLED': { title: 'Not enrolled', hint: 'You are not on the roster for this class. Contact your instructor.', suspicious: false },
  'E-GEO': { title: 'Outside geofence', hint: 'Move inside the room and retry.', suspicious: false },
  'E-GPS-WEAK': { title: 'Location too imprecise', hint: 'Step near a window or enable precise location, then retry.', suspicious: false },
  'E-GPS-STALE': { title: 'Location fix is stale', hint: 'Wait for a fresh GPS fix and retry.', suspicious: false },
  'E-MOCK': { title: 'Fake location detected', hint: 'Disable mock-location apps and developer location overrides.', suspicious: true },
  'E-DEVICE': { title: 'Device mismatch', hint: 'Scans are only accepted from your bound device.', suspicious: true },
  'E-INTEGRITY': { title: 'Device integrity failed', hint: 'Rooted, jailbroken or tampered devices cannot mark attendance.', suspicious: true },
  'E-DUPE': { title: 'Already marked', hint: 'Your attendance for this session is already recorded.', suspicious: false },
  'E-REVOKED': { title: 'Mark removed by instructor', hint: 'Your instructor removed your mark for this session. Speak to them if this is wrong.', suspicious: false },
  'E-PAUSED': { title: 'Scanning paused', hint: 'Attendance marking is temporarily paused by your institution.', suspicious: false },
} as const;

export type RejectionCode = keyof typeof REJECTION_CODES;

export function isRejectionCode(code: unknown): code is RejectionCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(REJECTION_CODES, code);
}

/** Generic API error codes (non-scan). */
export const API_ERROR_CODES = {
  BAD_REQUEST: 'The request was malformed.',
  UNAUTHENTICATED: 'Please sign in again.',
  TOKEN_EXPIRED: 'Session expired.',
  BAD_SIGNATURE: 'Request signature could not be verified.',
  CLOCK_SKEW: 'Your device clock is too far off. Enable automatic date & time.',
  REPLAY: 'This request was already processed.',
  FORBIDDEN: 'You do not have access to this.',
  NOT_FOUND: 'Not found.',
  RATE_LIMITED: 'Too many attempts. Please wait and try again.',
  OTP_INVALID: 'That code is incorrect.',
  OTP_EXPIRED: 'That code has expired. Request a new one.',
  OTP_LOCKED: 'Too many wrong attempts. Request a new code.',
  INSTITUTION_UNKNOWN: 'This institution is not registered with Attendly.',
  TICKET_INVALID: 'This sign-in step expired. Please sign in again.',
  DEVICE_REVOKED: 'This device is no longer bound to your account.',
  INTEGRITY: 'This device failed integrity checks (rooted / jailbroken / emulator).',
  LIMIT_REACHED: 'You have reached the limit for this request.',
  CONFLICT: 'A conflicting request already exists.',
  ACCOUNT_SUSPENDED: 'Your account is suspended. Contact your institution.',
  REJECTED: 'The server refused the mark.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Present only when code === 'REJECTED'. */
    rejection?: { code: RejectionCode; title: string; hint: string; detail?: string };
  };
}
