import { buildApp, startJanitor } from './app';
import { ConfigError, loadConfig } from './config';
import { createPool } from './db';
import { migrate } from './migrate';
import { seedDemo } from './seed';
import { bootstrapInstitution } from './bootstrap';
import { materializeTimetable } from './lib/timetable';
import { PUSH_APPS, PUSH_ENV, createPushSender, pushConfig, startPushDispatcher, type PushApp, type PushSender } from './lib/push';
import { startRevocationRefresh } from './lib/device-trust';
import { startClassClock } from './lib/class-clock';
import { ensureDeveloperAccess, ensureOwners } from './lib/platform-access';

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl, config.databasePoolMax, config.databaseSsl);
  await migrate(db, undefined, (m) => console.log(`[migrate] ${m}`));
  // First-run institution + admin (production). Failure is reported but never blocks serving.
  await bootstrapInstitution(db, config, (m) => console.log(`[bootstrap] ${m}`)).catch((err: Error) => console.error(`[bootstrap] failed: ${err.message}`));
  if (config.seedDemo) {
    // Best effort: demo data must never stop the API from serving.
    await seedDemo(db, config, { log: (m) => console.log(`[seed] ${m}`) }).catch((err: Error) => console.error(`[seed] skipped: ${err.message}`));
    await materializeTimetable(db).catch((err: Error) => console.error(`[timetable] ${err.message}`));
  }
  // Every institution has a main admin (older data: its earliest admin).
  await ensureOwners(db).catch((err: Error) => console.error(`[owners] ${err.message}`));
  const { app, deps } = await buildApp({ config, db });
  // The platform owner links Google Authenticator once with a setup code printed here.
  await ensureDeveloperAccess(db, config, deps.hash, deps.clock(), (m) => console.log(`[developer] ${m}`)).catch((err: Error) => console.error(`[developer] ${err.message}`));

  if (config.otpDelivery === 'console') app.log.warn('OTP_DELIVERY=console — sign-in codes are printed to this log, not emailed.');
  if (config.env === 'production' && config.devToolsToken) app.log.warn('DEV_TOOLS_TOKEN is set in production. Unset it before real use.');
  app.log.info({ kid: deps.signer.kid }, 'server signing key loaded');

  const stopJanitor = startJanitor(deps);
  // One sender per Firebase project (the two apps may share one project or have one each).
  const fcm = pushConfig();
  const byProject = new Map<string, PushSender>();
  const senders: Partial<Record<PushApp, PushSender>> = {};
  for (const a of PUSH_APPS) {
    const sa = fcm[a];
    if (!sa) {
      app.log.info(`instant push off for the ${a} app (${PUSH_ENV[a]} / FCM_SERVICE_ACCOUNT not set): it checks for news itself`);
      continue;
    }
    const key = `${sa.project_id}|${sa.client_email}`;
    if (!byProject.has(key)) byProject.set(key, createPushSender(sa, (m, x) => app.log.warn(x, m), process.env[PUSH_ENV[a]] ? PUSH_ENV[a] : 'FCM_SERVICE_ACCOUNT'));
    senders[a] = byProject.get(key);
    app.log.info(`instant push on for the ${a} app (Firebase project ${sa.project_id})`);
  }
  const stopPush = byProject.size ? startPushDispatcher(db, senders, (m, x) => app.log.warn(x, m), config.publicUrl) : () => {};
  // Google's list of revoked phone attestation keys (leaked or compromised), refreshed in the background.
  const stopRevocations = startRevocationRefresh((m) => app.log.info(m));
  // Classes go live by themselves at their start time.
  const stopClassClock = startClassClock(db, deps.clock, (m) => app.log.info(m));
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down gracefully`);
    stopJanitor();
    stopPush();
    stopRevocations();
    stopClassClock();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
      await db.end();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => app.log.error({ reason }, 'unhandled promise rejection'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error('Fatal startup error:', err);
  process.exit(1);
});
