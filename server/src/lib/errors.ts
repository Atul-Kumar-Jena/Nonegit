import { API_ERROR_CODES, REJECTION_CODES, type ApiErrorBody, type ApiErrorCode, type RejectionCode } from '@attendly/protocol';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? API_ERROR_CODES[code]);
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.extra ?? {}) } };
  }
}

/** A refused attendance mark. Carries the rejection code shown on the student's "rejected" screen. */
export class ScanRejection extends Error {
  constructor(
    readonly code: RejectionCode,
    readonly detail?: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(REJECTION_CODES[code].title);
  }

  toBody(): ApiErrorBody {
    const r = REJECTION_CODES[this.code];
    return {
      error: {
        code: 'REJECTED',
        message: API_ERROR_CODES.REJECTED,
        rejection: { code: this.code, title: r.title, hint: r.hint, ...(this.detail ? { detail: this.detail } : {}) },
      },
    };
  }
}

export const unauthenticated = (msg?: string) => new ApiError(401, 'UNAUTHENTICATED', msg);
export const badRequest = (msg?: string) => new ApiError(400, 'BAD_REQUEST', msg);
export const forbidden = (msg?: string) => new ApiError(403, 'FORBIDDEN', msg);
