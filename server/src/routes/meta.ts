import type { FastifyInstance } from 'fastify';
import { API_VERSION, type MetaResponse } from '@attendly/protocol';
import type { Deps } from '../deps';
import { listDemoAccounts } from '../lib/demo';
import { switchOn } from '../lib/flags';
import { THUMBS } from '../lib/thumbs-data';

export async function metaRoutes(app: FastifyInstance, deps: Deps) {
  /** Notification thumbnails (shown next to each push on the phone). Public, immutable. */
  app.get('/v1/thumbs/:name', async (req, reply) => {
    const name = String((req.params as { name?: string }).name ?? '').replace(/\.png$/, '');
    const b64 = Object.prototype.hasOwnProperty.call(THUMBS, name) ? THUMBS[name] : undefined;
    if (!b64) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=604800, immutable').header('cross-origin-resource-policy', 'cross-origin').send(Buffer.from(b64, 'base64'));
  });

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
