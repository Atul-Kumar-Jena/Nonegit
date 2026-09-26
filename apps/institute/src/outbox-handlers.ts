import { z } from 'zod';
import { EndSessionBody, ManualBody, StartSessionBody } from '@attendly/protocol';
import { ApiRequestError } from '@kit/lib/api-core';
import type { OutboxHandler } from '@kit/lib/outbox';
import { staffApi } from './api';

const StartPayload = z.object({ sessionId: z.uuid(), body: StartSessionBody });
const EndPayload = z.object({ sessionId: z.uuid(), body: EndSessionBody });
const RegisterPayload = z.object({ sessionId: z.uuid(), body: ManualBody });

/** A refusal that no retry can fix: report it instead of leaving it stuck. */
function refusal(err: unknown): { ok: false; message: string } | null {
  if (err instanceof ApiRequestError && (err.code === 'CONFLICT' || err.code === 'NOT_FOUND')) return { ok: false, message: err.message };
  return null;
}

/** A class started without internet. */
const start: OutboxHandler = async (api, item) => {
  const p = StartPayload.parse(item.payload);
  try {
    await staffApi.start(api, p.sessionId, p.body);
    return { ok: true, message: 'class start synced' };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
};

/** A class ended without internet. */
const end: OutboxHandler = async (api, item) => {
  const p = EndPayload.parse(item.payload);
  try {
    await staffApi.end(api, p.sessionId, p.body);
    return { ok: true, message: 'class end synced' };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
};

/** A paper-style register taken without internet. Refusals stay visible (retry / discard) so nothing is silently lost. */
const register: OutboxHandler = async (api, item) => {
  const p = RegisterPayload.parse(item.payload);
  const res = await staffApi.register(api, p.sessionId, p.body);
  return { ok: true, message: `register saved · ${res.present} present, ${res.absent} absent` };
};

export const instituteOutboxHandlers = { 'session.start': start, 'session.end': end, register };
