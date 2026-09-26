/**
 * Attendly server CLI.
 *
 *   keys            print freshly generated secrets for .env
 *   migrate         apply database migrations
 *   seed [--reset]  create the demo institution, people, courses and history
 *   session:start   start a live session (for testing without the Admin app)
 *   audit:verify    recompute the hash chain of the audit log
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { toB64url } from '@attendly/protocol';
import { loadConfig, type Config } from '../src/config';
import { createPool, withTx, type Db } from '../src/db';
import { migrate } from '../src/migrate';
import { verifyAuditChain } from '../src/lib/audit';
import { createSession } from '../src/lib/sessions';
import { seedDemo } from '../src/seed';
import { materializeTimetable } from '../src/lib/timetable';

function db(config: Config): Db {
  return createPool(config.databaseUrl, 4, config.databaseSsl);
}

// ─────────────────────────────── keys ───────────────────────────────
function keys() {
  const k = (n: number) => toB64url(new Uint8Array(nodeRandomBytes(n)));
  console.log('# Paste into server/.env — keep these secret, never commit them.');
  console.log(`SERVER_SIGNING_KEY=${k(32)}`);
  console.log(`TOKEN_PEPPER=${k(32)}`);
  console.log(`DEV_TOOLS_TOKEN=${k(24)}`);
}

// ─────────────────────────────── seed ───────────────────────────────
async function seed(config: Config, reset: boolean) {
  const pool = db(config);
  try {
    await migrate(pool);
    await seedDemo(pool, config, { reset });
    const n = await materializeTimetable(pool);
    console.log(`Generated ${n} upcoming classes from the timetable.`);
  } finally {
    await pool.end();
  }
}

// ─────────────────────────── session:start ───────────────────────────
async function sessionStart(config: Config, args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      course: { type: 'string' },
      lat: { type: 'string' },
      lng: { type: 'string' },
      radius: { type: 'string', default: '50' },
      rotation: { type: 'string', default: '7' },
      minutes: { type: 'string', default: '60' },
      room: { type: 'string', default: 'LH-2 · Block C' },
    },
  });
  const lat = Number(values.lat);
  const lng = Number(values.lng);
  const radius = Number(values.radius);
  const rotation = Number(values.rotation);
  const minutes = Number(values.minutes);
  if (!values.course || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    throw new Error('usage: npm run session:start -- --course CS-301 --lat 28.5450 --lng 77.1926 [--radius 50] [--rotation 7] [--minutes 60]');
  if (!Number.isInteger(radius) || radius < 10 || radius > 1000) throw new Error('--radius must be 10..1000');
  if (!Number.isInteger(rotation) || rotation < 3 || rotation > 60) throw new Error('--rotation must be 3..60');
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw new Error('--minutes must be 5..240');
  const pool = db(config);
  try {
    const s = await withTx(pool, async (tx) => {
      const c = await tx.query<{ id: string; tenant_id: string }>('select id, tenant_id from courses where code = $1 order by created_at desc limit 1', [
        values.course,
      ]);
      if (!c.rows[0]) throw new Error(`course ${values.course} not found (did you run "npm run seed"?)`);
      const now = new Date();
      return createSession(tx, {
        tenantId: c.rows[0].tenant_id,
        courseId: c.rows[0].id,
        room: values.room ?? null,
        lat,
        lng,
        radiusM: radius,
        rotationS: rotation,
        status: 'live',
        scheduledStart: now,
        scheduledEnd: new Date(now.getTime() + minutes * 60_000),
        startedAt: now,
        createdBy: null,
      });
    });
    console.log(`Live session ${s.shortCode} (${s.id}) started.`);
    if (config.devToolsToken) console.log(`Show its rotating QR at: http://localhost:${config.port}/dev?token=${config.devToolsToken}`);
    else console.log('Set DEV_TOOLS_TOKEN in .env to display the rotating QR at /dev.');
  } finally {
    await pool.end();
  }
}

// ─────────────────────────────── main ───────────────────────────────
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'keys') return keys();
  const config = loadConfig();
  switch (cmd) {
    case 'migrate': {
      const pool = db(config);
      try {
        const applied = await migrate(pool, undefined, (m) => console.log(m));
        console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
      } finally {
        await pool.end();
      }
      return;
    }
    case 'seed':
      return seed(config, rest.includes('--reset'));
    case 'session:start':
      return sessionStart(config, rest);
    case 'audit:verify': {
      const pool = db(config);
      try {
        const r = await verifyAuditChain(pool);
        if (r.ok) {
          console.log(`Audit log intact: ${r.checked} entries across ${r.chains} chain(s).`);
          for (const [chain, head] of Object.entries(r.heads ?? {})) console.log(`  ${chain}  head ${head}`);
        } else {
          console.error(`AUDIT CHAIN BROKEN at entry #${r.brokenAtId} (after ${r.checked} valid entries)`);
          process.exitCode = 2;
        }
      } finally {
        await pool.end();
      }
      return;
    }
    default:
      console.log('commands: keys | migrate | seed [--reset] | session:start --course CODE --lat N --lng N | audit:verify');
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
