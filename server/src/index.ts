import { buildApp, startJanitor } from './app';
import { ConfigError, loadConfig } from './config';
import { createPool } from './db';
import { migrate } from './migrate';
import { seedDemo } from './seed';
import { bootstrapInstitution } from './bootstrap';
import { materializeTimetable } from './lib/timetable';
import { createPushSender, parseServiceAccount, startPushDispatcher } from './lib/push';
import { startRevocationRefresh } from './lib/device-trust';
import { startClassClock } from './lib/class-clock';

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
  const { app, deps } = await buildApp({ config, db });

  if (config.otpDelivery === 'console') app.log.warn('OTP_DELIVERY=console — sign-in codes are printed to this log, not emailed.');
  if (config.env === 'production' && config.devToolsToken) app.log.warn('DEV_TOOLS_TOKEN is set in production. Unset it before real use.');
  app.log.info({ kid: deps.signer.kid }, 'server signing key loaded');

  const stopJanitor = startJanitor(deps);
  const fcm = parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT);
  const stopPush = fcm ? startPushDispatcher(db, createPushSender(fcm, (m, x) => app.log.warn(x, m)), (m, x) => app.log.warn(x, m), config.publicUrl) : () => {};
  app.log.info(fcm ? `instant push on (Firebase project ${fcm.project_id})` : 'instant push off (FCM_SERVICE_ACCOUNT not set): apps check for news themselves');
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
