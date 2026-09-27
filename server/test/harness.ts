import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import {
  bindProofString,
  currentQrSeq,
  encodeQrToken,
  generateKeyPair,
  loginProofString,
  randomToken,
  requestSigningString,
  sha256Hex,
  signB64,
  toB64url,
  type DeviceInfo,
  type KeyPair,
} from '@attendly/protocol';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createPool, withTx, type Db } from '../src/db';
import { migrate } from '../src/migrate';
import type { OtpMessage, OtpSender } from '../src/lib/delivery';
import { createSession } from '../src/lib/sessions';
import type { Deps } from '../src/deps';

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';

export interface TestCtx {
  app: FastifyInstance;
  deps: Deps;
  db: Db;
  sent: OtpMessage[];
  clock: { now: number };
  close(): Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}, opts: { rateLimit?: boolean } = {}): Promise<TestCtx> {
  const name = `attendly_t_${nodeRandomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    SERVER_SIGNING_KEY: toB64url(new Uint8Array(nodeRandomBytes(32))),
    TOKEN_PEPPER: toB64url(new Uint8Array(nodeRandomBytes(32))),
    LOG_LEVEL: 'silent',
    ...env,
  });
  const db = createPool(config.databaseUrl, 10, false);
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  const sent: OtpMessage[] = [];
  const sender: OtpSender = { supports: () => true, send: async (m) => void sent.push(m) };
  const clock = { now: Date.now() };
  const { app, deps } = await buildApp({ config, db, sender, clock: () => clock.now, logger: false, rateLimit: opts.rateLimit ?? false });
  await app.ready();
  return {
    app,
    deps,
    db,
    sent,
    clock,
    async close() {
      await app.close();
      await db.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export interface Seeded {
  tenantId: string;
  otherTenantId: string;
  studentId: string;
  student2Id: string;
  outsiderId: string;
  courseId: string;
  otherCourseId: string;
  foreignCourseId: string;
}

export const CENTER = { lat: 28.545, lng: 77.1926 };

export async function seedBasic(db: Db): Promise<Seeded> {
  return withTx(db, async (tx) => {
    const t = await tx.query<{ id: string }>(
      `insert into tenants(slug, name, email_domains, term_start) values ('iit', 'IIT Test', '{iit.ac.in}', current_date - 30) returning id`,
    );
    const t2 = await tx.query<{ id: string }>(
      `insert into tenants(slug, name, email_domains, term_start) values ('other', 'Other U', '{other.edu}', current_date - 30) returning id`,
    );
    const tenantId = t.rows[0]!.id;
    const otherTenantId = t2.rows[0]!.id;
    const u = async (tenant: string, email: string, phone: string | null, role = 'student') =>
      (
        await tx.query<{ id: string }>(
          `insert into users(tenant_id, role, full_name, email, phone, roll_no) values ($1, $2, $3, $4, $5, $6) returning id`,
          [tenant, role, email.split('@')[0], email, phone, email.split('@')[0]],
        )
      ).rows[0]!.id;
    const studentId = await u(tenantId, 'aarav@iit.ac.in', '+919000000001');
    const student2Id = await u(tenantId, 'priya@iit.ac.in', null);
    const outsiderId = await u(otherTenantId, 'zed@other.edu', null);
    const c = async (tenant: string, code: string) =>
      (await tx.query<{ id: string }>(`insert into courses(tenant_id, code, title) values ($1, $2, $2) returning id`, [tenant, code])).rows[0]!.id;
    const courseId = await c(tenantId, 'CS-301');
    const otherCourseId = await c(tenantId, 'MA-202');
    const foreignCourseId = await c(otherTenantId, 'X-100');
    for (const [cid, uid] of [
      [courseId, studentId],
      [courseId, student2Id],
      [otherCourseId, student2Id],
      [foreignCourseId, outsiderId],
    ] as const)
      await tx.query('insert into enrollments(course_id, user_id) values ($1, $2)', [cid, uid]);
    return { tenantId, otherTenantId, studentId, student2Id, outsiderId, courseId, otherCourseId, foreignCourseId };
  });
}

export async function startLiveSession(
  ctx: TestCtx,
  p: { tenantId: string; courseId: string; radiusM?: number; rotationS?: number; startedAt?: number; status?: 'live' | 'scheduled' | 'closed' },
) {
  return withTx(ctx.db, async (tx) => {
    const started = new Date(p.startedAt ?? ctx.clock.now);
    const s = await createSession(tx, {
      tenantId: p.tenantId,
      courseId: p.courseId,
      room: 'LH-2',
      lat: CENTER.lat,
      lng: CENTER.lng,
      radiusM: p.radiusM ?? 50,
      rotationS: p.rotationS ?? 7,
      status: p.status ?? 'live',
      scheduledStart: started,
      scheduledEnd: new Date(started.getTime() + 3_600_000),
      startedAt: p.status === 'scheduled' ? null : started,
      createdBy: null,
    });
    const { rows } = await tx.query<{ qr_secret: Buffer }>('select qr_secret from class_sessions where id = $1', [s.id]);
    return { id: s.id, secret: new Uint8Array(rows[0]!.qr_secret), startedAt: started.getTime() };
  });
}

/** A simulated phone: holds its own Ed25519 key and signs every request exactly like the app. */
export class TestDevice {
  readonly keys: KeyPair;
  accessToken?: string;
  refreshToken?: string;

  constructor(
    private ctx: TestCtx,
    readonly overrides: Partial<DeviceInfo> = {},
  ) {
    this.keys = generateKeyPair();
  }

  get publicKeyB64() {
    return toB64url(this.keys.publicKey);
  }

  info(): DeviceInfo {
    return {
      publicKey: this.publicKeyB64,
      platform: 'android',
      model: 'Pixel 8',
      osVersion: '15',
      appVersion: '1.0.0',
      integrity: { rooted: false, emulator: false },
      ...this.overrides,
    };
  }

  async requestOtp(identifier: string, channel: 'email' | 'phone' = 'email', institutionCode?: string) {
    return this.ctx.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { channel, identifier, ...(institutionCode ? { institutionCode } : {}) } });
  }

  lastCode(to: string): string {
    const m = [...this.ctx.sent].reverse().find((x) => x.to === to);
    if (!m) throw new Error(`no OTP sent to ${to}`);
    return m.code;
  }

  async verifyOtp(challengeId: string, code: string, proofOverride?: string) {
    const proof = proofOverride ?? signB64(loginProofString({ challengeId, publicKeyB64: this.publicKeyB64 }), this.keys.secretKey);
    return this.ctx.app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { challengeId, code, device: this.info(), proof } });
  }

  async bind(ticket: string) {
    const proof = signB64(bindProofString({ ticket, publicKeyB64: this.publicKeyB64, purpose: 'bind' }), this.keys.secretKey);
    const res = await this.ctx.app.inject({ method: 'POST', url: '/v1/devices/bind', payload: { ticket, proof } });
    if (res.statusCode === 200) this.adopt(res.json().auth);
    return res;
  }

  adopt(auth: { accessToken: string; refreshToken: string }) {
    this.accessToken = auth.accessToken;
    this.refreshToken = auth.refreshToken;
  }

  /** Full sign-in: request OTP → verify → bind. */
  async signIn(email: string, institutionCode?: string) {
    const r = await this.requestOtp(email, 'email', institutionCode);
    if (r.statusCode !== 200) throw new Error(`otp request failed: ${r.body}`);
    const v = await this.verifyOtp(r.json().challengeId, this.lastCode(email));
    const body = v.json();
    if (body.status === 'bind_required') {
      const b = await this.bind(body.ticket);
      if (b.statusCode !== 200) throw new Error(`bind failed: ${b.body}`);
      return b.json();
    }
    if (body.status === 'ok') {
      this.adopt(body.auth);
      return body;
    }
    throw new Error(`unexpected sign-in result: ${v.body}`);
  }

  signedHeaders(method: string, url: string, body: string, opts: { ts?: number; nonce?: string; key?: Uint8Array } = {}) {
    const ts = opts.ts ?? this.ctx.clock.now;
    const nonce = opts.nonce ?? randomToken(16);
    const sig = signB64(
      requestSigningString({ method, pathWithQuery: url, timestampMs: ts, nonce, bodySha256Hex: sha256Hex(body) }),
      opts.key ?? this.keys.secretKey,
    );
    return { 'x-attendly-ts': String(ts), 'x-attendly-nonce': nonce, 'x-attendly-sig': sig };
  }

  async call(method: 'GET' | 'POST', url: string, payload?: unknown, opts: { ts?: number; nonce?: string; key?: Uint8Array; token?: string; tamper?: string } = {}) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers: Record<string, string> = {
      ...this.signedHeaders(method, url, body, opts),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    const token = opts.token ?? this.accessToken;
    if (token) headers.authorization = `Bearer ${token}`;
    return this.ctx.app.inject({ method, url, headers, payload: opts.tamper ?? (payload === undefined ? undefined : body) });
  }

  async refresh(refreshToken = this.refreshToken!) {
    const body = JSON.stringify({ refreshToken });
    const res = await this.ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { ...this.signedHeaders('POST', '/v1/auth/refresh', body), 'content-type': 'application/json' },
      payload: body,
    });
    return res;
  }
}

/** The QR token a teacher's screen shows right now for session `s` (offset = rotations from now). */
export function liveToken(ctx: TestCtx, s: { id: string; secret: Uint8Array }, rotationS = 7, offset = 0): string {
  return encodeQrToken(s.secret, s.id, currentQrSeq(ctx.clock.now, rotationS) + offset);
}

export function at(metersNorth: number) {
  return { lat: CENTER.lat + metersNorth / 111_195, lng: CENTER.lng };
}
