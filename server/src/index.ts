import { buildApp, startJanitor } from './app';
import { ConfigError, loadConfig } from './config';
import { createPool } from './db';
import { migrate } from './migrate';

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl, config.databasePoolMax, config.databaseSsl);
  await migrate(db, undefined, (m) => console.log(`[migrate] ${m}`));
  const { app, deps } = await buildApp({ config, db });

  if (config.otpDelivery === 'console') app.log.warn('OTP_DELIVERY=console — sign-in codes are printed to this log, not emailed.');
  if (config.env === 'production' && config.devToolsToken) app.log.warn('DEV_TOOLS_TOKEN is set in production. Unset it before real use.');
  app.log.info({ kid: deps.signer.kid }, 'server signing key loaded');

  const stopJanitor = startJanitor(deps);
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down gracefully`);
    stopJanitor();
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
