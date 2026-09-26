/**
 * Canonical byte strings that get signed. Every message starts with a unique
 * domain-separation tag so a signature produced for one purpose can never be
 * replayed for another. Fields are newline-joined and each field is checked to
 * contain no newline, so the encoding is unambiguous.
 */

export const TAG_REQUEST = 'ATTENDLY-REQ-v1';
export const TAG_LOGIN = 'ATTENDLY-LOGIN-v1';
export const TAG_BIND = 'ATTENDLY-BIND-v1';
export const TAG_RECEIPT = 'ATTENDLY-RECEIPT-v1';

function join(fields: readonly (string | number)[]): string {
  return fields
    .map((f) => {
      const s = String(f);
      if (s.includes('\n') || s.includes('\r')) throw new Error('canonical message field contains a newline');
      return s;
    })
    .join('\n');
}

/**
 * Every authenticated API call is signed by the device key.
 * `pathWithQuery` is the raw request target, e.g. "/v1/me/dashboard?x=1".
 * `bodySha256Hex` is the SHA-256 of the exact body bytes sent ("" body included).
 */
export function requestSigningString(p: {
  method: string;
  pathWithQuery: string;
  timestampMs: number;
  nonce: string;
  bodySha256Hex: string;
}): string {
  return join([TAG_REQUEST, p.method.toUpperCase(), p.pathWithQuery, p.timestampMs, p.nonce, p.bodySha256Hex]);
}

/** Proves the client holds the device key at OTP verification time. */
export function loginProofString(p: { challengeId: string; publicKeyB64: string }): string {
  return join([TAG_LOGIN, p.challengeId, p.publicKeyB64]);
}

/** Proves possession of the device key when binding (or requesting a rebind). */
export function bindProofString(p: { ticket: string; publicKeyB64: string; purpose: 'bind' | 'rebind' }): string {
  return join([TAG_BIND, p.purpose, p.ticket, p.publicKeyB64]);
}

export interface ReceiptFields {
  recordId: string;
  sessionId: string;
  userId: string;
  markedAt: string; // ISO-8601 UTC
  deviceFingerprint: string;
  qrSeq: number;
  serverKeyId: string;
}

/** The server signs this to give the student a verifiable proof of attendance. */
export function receiptSigningString(r: ReceiptFields): string {
  return join([TAG_RECEIPT, r.recordId, r.sessionId, r.userId, r.markedAt, r.deviceFingerprint, r.qrSeq, r.serverKeyId]);
}
