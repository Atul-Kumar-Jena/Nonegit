import { MarkBody } from '@attendly/protocol';
import { ApiRequestError } from '@kit/lib/api-core';
import type { OutboxHandler } from '@kit/lib/outbox';

/** Uploads a scan that was captured without internet. */
const mark: OutboxHandler = async (api, item) => {
  const body = MarkBody.parse(item.payload);
  try {
    const res = await api.mark(body);
    return { ok: true, message: `${res.record.courseCode} · marked present${res.alreadyMarked ? ' (already recorded)' : ''}` };
  } catch (err) {
    if (err instanceof ApiRequestError && err.rejection) return { ok: false, message: `${err.rejection.title}${err.rejection.detail ? ` — ${err.rejection.detail}` : ''}` };
    throw err;
  }
};

export const studentOutboxHandlers = { mark };
