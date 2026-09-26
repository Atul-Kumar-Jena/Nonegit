/**
 * "Please take my class" (cover) and students' questions to their teachers.
 * The logic lives in lib/requests; these routes only authenticate and validate.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CoverRequestBody,
  ReplyBody,
  StudentRequestBody,
  type ChangeRequest,
  type CoverResponse,
  type DecisionResponse,
  type RequestsResponse,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx } from '../db';
import { STAFF } from '../lib/access';
import { requireDevice } from '../lib/auth';
import { acceptRequest, cancelRequest, createCoverRequest, createStudentRequest, declineRequest, listRequests } from '../lib/requests';

const IdParam = z.object({ id: z.uuid() });
const write = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

export async function requestRoutes(app: FastifyInstance, deps: Deps) {
  // ── staff ──
  app.post('/v1/staff/cover-requests', write, async (req): Promise<CoverResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    const body = CoverRequestBody.parse(req.body);
    return withTx(deps.db, (tx) => createCoverRequest(tx, deps, auth, body));
  });

  app.get('/v1/staff/requests', async (req): Promise<RequestsResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    return listRequests(deps.db, auth, deps.clock());
  });

  app.post('/v1/staff/requests/:id/accept', write, async (req): Promise<DecisionResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const body = ReplyBody.parse(req.body ?? {});
    return withTx(deps.db, (tx) => acceptRequest(tx, deps, auth, id, body));
  });

  app.post('/v1/staff/requests/:id/decline', write, async (req): Promise<DecisionResponse> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const body = ReplyBody.parse(req.body ?? {});
    return withTx(deps.db, (tx) => declineRequest(tx, deps, auth, id, body));
  });

  app.post('/v1/staff/requests/:id/cancel', write, async (req): Promise<ChangeRequest> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    return withTx(deps.db, (tx) => cancelRequest(tx, deps, auth, id));
  });

  // ── students ──
  app.post('/v1/me/requests', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<ChangeRequest> => {
    const auth = await requireDevice(req, deps, ['student']);
    const body = StudentRequestBody.parse(req.body);
    return withTx(deps.db, (tx) => createStudentRequest(tx, deps, auth, body));
  });

  app.get('/v1/me/requests', async (req): Promise<RequestsResponse> => {
    const auth = await requireDevice(req, deps, ['student']);
    return listRequests(deps.db, auth, deps.clock());
  });

  app.post('/v1/me/requests/:id/cancel', write, async (req): Promise<ChangeRequest> => {
    const auth = await requireDevice(req, deps, ['student']);
    const { id } = IdParam.parse(req.params);
    return withTx(deps.db, (tx) => cancelRequest(tx, deps, auth, id));
  });
}
