import type { MarkResponse } from '@attendly/protocol';
import type { Rejection } from '@kit/lib/api-core';

/**
 * Hand-off from the scanner to the result screen. Kept in memory (not route
 * params) so nothing about a mark can be forged through a deep link.
 */
export type ScanOutcome =
  | { kind: 'success'; res: MarkResponse; receiptVerified: boolean }
  | { kind: 'rejected'; rejection: Rejection }
  | { kind: 'queued'; label: string }
  | { kind: 'error'; title: string; message: string };

let outcome: ScanOutcome | null = null;

export function setScanOutcome(o: ScanOutcome) {
  outcome = o;
}

export function takeScanOutcome(): ScanOutcome | null {
  return outcome;
}

export function clearScanOutcome() {
  outcome = null;
}
