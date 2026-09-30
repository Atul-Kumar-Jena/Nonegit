import { promisify } from 'node:util';
import { gzip as gzipCb, constants as zlibConstants } from 'node:zlib';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { PROBE_CODES, createGuard } from './lib/guard';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import type { Config } from './config';
import type { Db } from './db';
import type { Deps } from './deps';
import { createOtpSender, type OtpSender } from './lib/delivery';
import { ApiError } from './lib/errors';
import { materializeTimetable } from './lib/timetable';
import { RETENTION_EVERY_MS, runRetention } from './lib/retention';
import { createServerSigner } from './lib/keys';
import { makeHasher } from './lib/secrets';
import { creditRoutes } from './routes/credits';
import { attendanceRoutes } from './routes/attendance';
import { authRoutes } from './routes/auth';
import { presentRoutes } from './routes/present';
import { staffPlannerRoutes } from './routes/staff-planner';
import { requestRoutes } from './routes/requests';
import { rootRoutes } from './routes/root';
import { authenticatorRoutes } from './routes/authenticator';
import { setupRoutes } from './routes/setup';
import { rootSupportRoutes } from './routes/root-support';
import { rootBroadcastRoutes } from './routes/root-broadcast';
import { recordRequest } from './lib/metrics';
import { devRoutes } from './routes/dev';
import { metaRoutes } from './routes/meta';
import { studentRoutes } from './routes/student';
import { reportRoutes } from './routes/reports';
import { batchRoutes } from './routes/batches';
import { noticeRoutes } from './routes/notices';
import { staffAcademicRoutes } from './routes/staff-academics';
import { staffAdminRoutes } from './routes/staff-admin';
import { staffSessionRoutes } from './routes/staff-sessions';

export interface BuildOptions {
  config: Config;
  db: Db;
  sender?: OtpSender;
  clock?: () => number;
  logger?: boolean;
  /** Per-IP rate limiting (on by default; integration tests turn it off). */
  rateLimit?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; deps: Deps }> {
  const { config } = opts;
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            serializers: {
              // Never log query strings (the dev console token travels in one).
              req: (req) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }),
            },
            redact: {
              paths: ['req.headers.authorization', 'req.headers["x-attendly-sig"]', 'req.headers["x-dev-token"]', 'req.query.token'],
              remove: true,
            },
          },
    // One line per request is noise at scale (and costs CPU): slow and failed requests are logged below.
    disableRequestLogging: config.env === 'production',
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024,
    requestTimeout: 30_000,
    // Longer than the host's load balancer keeps idle connections, so phones reuse warm connections
    // instead of hitting a socket the server just closed (random 502s under load).
    keepAliveTimeout: 75_000,
  });

  const deps: Deps = {
    config,
    db: opts.db,
    hash: makeHasher(config.tokenPepper),
    signer: createServerSigner(config.serverSigningSeed),
    sender: opts.sender ?? createOtpSender(config, app.log),
    clock: opts.clock ?? Date.now,
    log: app.log,
    guard: createGuard(opts.rateLimit !== false),
  };

  // Keep the exact body bytes: device signatures cover SHA-256(raw body).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new ApiError(400, 'BAD_REQUEST', 'Body is not valid JSON.'), undefined);
    }
  });

  // Per-IP flood guard. Deliberately generous: a whole class on campus Wi-Fi shares one
  // public IP. Fine-grained limits are keyed per device on the routes themselves.
  if (opts.rateLimit !== false) await app.register(rateLimit, {
    global: true,
    max: 3000,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => {
      const err = new ApiError(429, 'RATE_LIMITED', undefined, { retryAfterSec: Math.ceil(ctx.ttl / 1000) });
      return Object.assign(err, { statusCode: 429 });
    },
  });
  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsOrigins,
      allowedHeaders: ['authorization', 'content-type', 'x-attendly-ts', 'x-attendly-nonce', 'x-attendly-sig', 'x-attendly-key', 'x-present-secret'],
      exposedHeaders: ['x-server-time'],
    });
  }

  // Shut out IPs that keep probing with bad signatures / replayed or unknown tokens.
  app.addHook('onRequest', async (req, reply) => {
    const wait = deps.guard.ipBlockedFor(req.ip, deps.clock());
    if (wait > 0) return reply.code(429).send(new ApiError(429, 'RATE_LIMITED', 'Too many invalid requests from your network. Try again later.', { retryAfterSec: Math.ceil(wait / 1000) }).toBody());
  });
  app.addHook('onResponse', async (req, reply) => {
    recordRequest(reply.elapsedTime, reply.statusCode);
    if (config.env === 'production' && (reply.elapsedTime > 1500 || reply.statusCode >= 500))
      req.log.warn({ method: req.method, url: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, reply.statusCode >= 500 ? 'request failed' : 'slow request');
    const code = (reply as typeof reply & { probeCode?: string }).probeCode;
    if (code && PROBE_CODES.has(code)) deps.guard.recordProbe(req.ip, deps.clock());
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-server-time', String(deps.clock()));
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-resource-policy', 'same-site');
    if (config.env === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!reply.getHeader('cache-control')) reply.header('cache-control', 'no-store');
    return compress(req.headers['accept-encoding'], reply, payload);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      (reply as typeof reply & { probeCode?: string }).probeCode = err.code;
      return reply.code(err.status).send(err.toBody());
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return reply.code(400).send(new ApiError(400, 'BAD_REQUEST', `${where}${issue?.message ?? 'invalid request'}`).toBody());
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) return reply.code(429).send(new ApiError(429, 'RATE_LIMITED').toBody());
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      const code = e.statusCode === 404 ? 'NOT_FOUND' : 'BAD_REQUEST';
      return reply.code(e.statusCode).send(new ApiError(e.statusCode, code, e.statusCode === 413 ? 'Request too large.' : undefined).toBody());
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(new ApiError(500, 'INTERNAL').toBody());
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(new ApiError(404, 'NOT_FOUND').toBody()));

  await app.register(async (s) => metaRoutes(s, deps));
  await app.register(async (s) => authRoutes(s, deps));
  await app.register(async (s) => studentRoutes(s, deps));
  await app.register(async (s) => reportRoutes(s, deps));
  await app.register(async (s) => batchRoutes(s, deps));
  await app.register(async (s) => noticeRoutes(s, deps));
  await app.register(async (s) => attendanceRoutes(s, deps));
  await app.register(async (s) => creditRoutes(s, deps));
  await app.register(async (s) => staffAdminRoutes(s, deps));
  await app.register(async (s) => staffAcademicRoutes(s, deps));
  await app.register(async (s) => staffSessionRoutes(s, deps));
  await app.register(async (s) => staffPlannerRoutes(s, deps));
  await app.register(async (s) => presentRoutes(s, deps));
  await app.register(async (s) => requestRoutes(s, deps));
  await app.register(async (s) => rootRoutes(s, deps));
  await app.register(async (s) => authenticatorRoutes(s, deps));
  await app.register(async (s) => setupRoutes(s, deps));
  await app.register(async (s) => rootSupportRoutes(s, deps));
  await app.register(async (s) => rootBroadcastRoutes(s, deps));
  await app.register(async (s) => devRoutes(s, deps));

  return { app, deps };
}

/** Periodic cleanup of expired, security-irrelevant rows. */
export function startJanitor(deps: Deps): () => void {
  let lastRetention = 0;
  const run = async () => {
    try {
      const now = new Date(deps.clock());
      // Data lifecycle (lib/retention.ts): trim working data about once an hour, in small batches.
      if (!lastRetention || now.getTime() - lastRetention >= RETENTION_EVERY_MS) {
        lastRetention = now.getTime();
        const removed = await runRetention(deps.db, now);
        const total = removed ? Object.values(removed).reduce((a, b) => a + b, 0) : 0;
        if (total) deps.log.info({ removed }, `retention: ${total} old rows removed`);
      }
      // Auto-close sessions that ran past their scheduled end by more than 30 minutes.
      await deps.db.query(
        `update class_sessions set status = 'closed', ended_at = greatest(scheduled_end, started_at) where status = 'live' and scheduled_end < $1`,
        [new Date(now.getTime() - 30 * 60_000)],
      );
      // Keep the next two weeks of every timetable turned into real classes.
      await materializeTimetable(deps.db);
    } catch (err) {
      deps.log.error({ err: (err as Error).message }, 'janitor run failed');
    }
  };
  const t = setInterval(run, 5 * 60_000);
  t.unref();
  void run();
  return () => clearInterval(t);
}

const gzip = promisify(gzipCb);

/**
 * Gzip JSON / text answers over 1 KB when the phone accepts it (Android's HTTP stack always does and
 * unpacks it transparently): timetables, reports and lists shrink 5–10×, which is most of the wait on
 * mobile data. Streams and tiny answers go out as they are.
 */
export async function compress(accept: string | string[] | undefined, reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
  if (reply.getHeader('content-encoding') || reply.statusCode === 204 || reply.statusCode === 304) return payload;
  const type = String(reply.getHeader('content-type') ?? '');
  if (!/json|text|javascript|svg/.test(type)) return payload;
  const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
  if (size < 1024 || !/\bgzip\b/.test(String(accept ?? ''))) return payload;
  const vary = reply.getHeader('vary');
  reply.header('vary', vary ? `${String(vary)}, accept-encoding` : 'accept-encoding');
  reply.header('content-encoding', 'gzip');
  reply.removeHeader('content-length');
  return gzip(payload, { level: 5, memLevel: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY });
}
