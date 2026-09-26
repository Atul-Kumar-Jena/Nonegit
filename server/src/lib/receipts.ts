import { receiptSigningString } from '@attendly/protocol';
import type { ServerSigner } from './keys';

/** Every attendance record — scanned, manual or reviewed — carries a server signature. */
export function signReceipt(
  signer: ServerSigner,
  r: { recordId: string; sessionId: string; userId: string; markedAt: Date; deviceFingerprint: string; qrSeq: number },
): Buffer {
  return Buffer.from(
    signer.sign(
      receiptSigningString({
        recordId: r.recordId,
        sessionId: r.sessionId,
        userId: r.userId,
        markedAt: r.markedAt.toISOString(),
        deviceFingerprint: r.deviceFingerprint,
        qrSeq: r.qrSeq,
        serverKeyId: signer.kid,
      }),
    ),
  );
}
