import { MarkBody } from '@attendly/protocol';
import { ApiRequestError } from '@kit/lib/api-core';
import type { OutboxHandler } from '@kit/lib/outbox';

/** Refusals that can clear up on their own, so an offline scan keeps waiting instead of failing. */
const WAIT_AND_RETRY = new Set(['E-NOT-STARTED', 'E-PAUSED']);

/** Uploads a scan that was captured without internet. */
const mark: OutboxHandler = async (api, item) => {
  const body = MarkBody.parse(item.payload);
  try {
    let res;
    try {
      res = await api.mark(body);
    } catch (err) {
      // Back online before this phone's one-time move to its security chip ran: do it now, then retry.
      if (!(err instanceof ApiRequestError && err.rejection?.code === 'E-DEVICE' && /isn’t secured yet/.test(err.rejection.detail ?? ''))) throw err;
      await api.secureWithChip();
      res = await api.mark(body);
    }
    return { ok: true, message: `marked present${res.alreadyMarked ? ' (already recorded)' : ''}${res.record.offline ? ' · offline scan accepted' : ''}` };
  } catch (err) {
    if (err instanceof ApiRequestError && err.rejection) {
      // The teacher may have started the class offline too — their phone hasn't synced yet.
      // Retry with backoff; the server refuses anything older than 24 h on its own.
      if (WAIT_AND_RETRY.has(err.rejection.code)) throw new ApiRequestError('INTERNAL', err.rejection.title, 503);
      return { ok: false, message: `${err.rejection.title}${err.rejection.detail ? ` — ${err.rejection.detail}` : ''}` };
    }
    throw err;
  }
};

export const studentOutboxHandlers = { mark };
