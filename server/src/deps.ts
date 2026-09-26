import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { Db } from './db';
import type { OtpSender } from './lib/delivery';
import type { ServerSigner } from './lib/keys';
import type { Hasher } from './lib/secrets';

/** Everything a route needs, injected so tests can swap the clock and OTP sender. */
export interface Deps {
  config: Config;
  db: Db;
  hash: Hasher;
  signer: ServerSigner;
  sender: OtpSender;
  clock: () => number;
  log: FastifyBaseLogger;
}
