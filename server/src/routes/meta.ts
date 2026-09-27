import type { FastifyInstance } from 'fastify';
import { API_VERSION, type MetaResponse } from '@attendly/protocol';
import type { Deps } from '../deps';
import { listDemoAccounts } from '../lib/demo';
import { switchOn } from '../lib/flags';

export async function metaRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/v1/meta', async (): Promise<MetaResponse> => ({
    demo: deps.config.demoInstantLogin && !(await switchOn(deps.db, 'demo_login_off').catch(() => false)) ? { instantLogin: true, ...(await listDemoAccounts(deps.db, deps.clock()).catch(() => ({ institution: null, institutionCode: null, accounts: [] }))) } : null,
    name: 'Attendly',
    apiVersion: API_VERSION,
    serverTime: deps.clock(),
    serverKey: { kid: deps.signer.kid, publicKey: deps.signer.publicKeyB64 },
    minAppVersion: deps.config.minAppVersion,
    channels: deps.sender.supports('phone') ? ['email', 'phone'] : ['email'],
  }));

  /** Liveness + DB readiness, for load balancers and uptime monitors. */
  app.get('/healthz', async (_req, reply) => {
    try {
      await deps.db.query('select 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
}
