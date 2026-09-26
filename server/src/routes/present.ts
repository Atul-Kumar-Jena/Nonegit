/**
 * Big-screen pairing ("present on a laptop / smartboard"), modelled on device login:
 *
 *   1. The screen opens /present and asks for a pairing → it gets a random 8-character
 *      code to show, plus a bearer secret it keeps to itself.
 *   2. The teacher types the code into the Institute app, sees which browser asked,
 *      and approves it for one live class (their own; signed, device-bound request).
 *   3. The screen polls with its secret and receives the *current* QR as an SVG.
 *      It never gets the class's QR secret, and it stops the moment the class ends
 *      or the teacher disconnects it.
 *
 * Codes live 5 minutes, are single-use, and are stored only as HMACs; secrets only as
 * SHA-256 hashes. Every approval / disconnect is written to the audit chain.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  PRESENT_CODE_ALPHABET,
  PresentCodeBody,
  currentQrSeq,
  encodeQrToken,
  hmacSha256,
  msUntilNextRotation,
  randomBytes,
  randomToken,
  seqLabel,
  sha256Bytes,
  timingSafeEqual,
  type PresentScreen,
} from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { STAFF, loadSessionFor } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { perDeviceKey, requireDevice, type AuthContext } from '../lib/auth';
import { ApiError } from '../lib/errors';

const PAIRING_TTL_MS = 5 * 60_000;
/** An approved screen keeps working at most this long (a very long class, or a forgotten tab). */
const APPROVED_MAX_MS = 12 * 60 * 60_000;
const IdParam = z.object({ id: z.uuid() });

function newCode(): string {
  // Rejection sampling over a 31-symbol alphabet: no modulo bias.
  let out = '';
  while (out.length < 8) {
    for (const b of randomBytes(16)) {
      if (b < 248 && out.length < 8) out += PRESENT_CODE_ALPHABET[b % 31];
    }
  }
  return out;
}

/** "Chrome on Windows", "Safari on iPad"… — enough for a teacher to recognise the screen. */
export function describeDevice(ua: string | undefined): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'A browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /CrOS/.test(ua)
      ? 'ChromeOS'
      : /iPad/.test(ua)
        ? 'iPad'
        : /iPhone/.test(ua)
          ? 'iPhone'
          : /Android/.test(ua)
            ? /Mobile/.test(ua)
              ? 'Android phone'
              : 'Android (TV / board / tablet)'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'Mac'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'an unknown system';
  return `${browser} on ${os}`;
}

/** 49.36.112.9 → 49.36.x.x (enough to tell "on campus" from "somewhere else"). */
function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.split('.').slice(0, 2).join('.') + '.x.x';
  return ip.split(':').slice(0, 3).join(':') + ':…';
}

interface PairingRow {
  id: string;
  secret_hash: Buffer;
  user_agent: string | null;
  ip: string | null;
  created_at: Date;
  expires_at: Date;
  tenant_id: string | null;
  session_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  revoked_at: Date | null;
}

export async function presentRoutes(app: FastifyInstance, deps: Deps) {
  const now = () => deps.clock();
  const codeHash = (code: string) => Buffer.from(hmacSha256(deps.config.tokenPepper, `present-code:${code}`));

  async function screensOf(db: Queryable, sessionId: string): Promise<PresentScreen[]> {
    const { rows } = await db.query<PairingRow & { approver: string | null }>(
      `select p.*, u.full_name as approver from present_pairings p left join users u on u.id = p.approved_by
        where p.session_id = $1 and p.revoked_at is null order by p.approved_at`,
      [sessionId],
    );
    return rows.map((r) => ({
      id: r.id,
      device: describeDevice(r.user_agent ?? undefined),
      ip: maskIp(r.ip),
      requestedAt: r.created_at.toISOString(),
      approvedAt: r.approved_at?.toISOString() ?? null,
      approvedBy: r.approver,
    }));
  }

  async function audit(tx: Queryable, auth: AuthContext, action: string, subject: string, data: Record<string, unknown>) {
    await appendAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action, subject, data });
  }

  // ── the screen ──

  app.get('/present', async (_req, reply) =>
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .send(PRESENT_PAGE),
  );
  app.get('/present.js', async (_req, reply) => reply.header('content-type', 'application/javascript; charset=utf-8').header('cache-control', 'no-store').send(PRESENT_JS));

  app.post('/v1/present/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const t = now();
    const code = newCode();
    const secret = randomToken(32);
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null;
    const { rows } = await deps.db.query<{ id: string }>(
      `insert into present_pairings(code_hash, secret_hash, user_agent, ip, created_at, expires_at) values ($1, $2, $3, $4, $5, $6) returning id`,
      [codeHash(code), Buffer.from(sha256Bytes(secret)), ua, req.ip, new Date(t), new Date(t + PAIRING_TTL_MS)],
    );
    // Housekeeping: forget abandoned codes.
    await deps.db.query(`delete from present_pairings where approved_at is null and expires_at < $1`, [new Date(t - 60 * 60_000)]);
    return { pairingId: rows[0]!.id, code: `${code.slice(0, 4)}-${code.slice(4)}`, secret, expiresAt: new Date(t + PAIRING_TTL_MS).toISOString() };
  });

  const presentKey = (req: FastifyRequest) => `present:${(req.params as { id?: string }).id ?? req.ip}`;

  /** The screen's poll: status, and while the class is live, the current QR. */
  app.get('/v1/present/:id', { config: { rateLimit: { max: 180, timeWindow: '1 minute', keyGenerator: presentKey } } }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const secret = req.headers['x-present-secret'];
    const { rows } = await deps.db.query<PairingRow>('select * from present_pairings where id = $1', [id]);
    const p = rows[0];
    if (!p || typeof secret !== 'string' || !timingSafeEqual(sha256Bytes(secret), new Uint8Array(p.secret_hash)))
      throw new ApiError(404, 'NOT_FOUND', 'This pairing no longer exists. Start again.');
    const t = now();
    if (p.revoked_at) return { status: 'disconnected' as const };
    if (!p.approved_at || !p.session_id) return t > p.expires_at.getTime() ? { status: 'expired' as const } : { status: 'waiting' as const, expiresAt: p.expires_at.toISOString() };
    if (t - p.approved_at.getTime() > APPROVED_MAX_MS) return { status: 'expired' as const };

    const s = await deps.db.query<{
      status: string;
      mode: string;
      qr_secret: Buffer;
      rotation_s: number;
      short_code: string;
      lecture_no: number | null;
      code: string;
      title: string;
      room: string | null;
      marked: number;
      enrolled: number;
    }>(
      `select s.status, s.mode, s.qr_secret, s.rotation_s, s.short_code, s.lecture_no, c.code, c.title, coalesce(r.name, s.room) as room,
              (select count(*)::int from attendance_records a where a.session_id = s.id and a.revoked_at is null) as marked,
              (select count(*)::int from enrollments e join users u on u.id = e.user_id and u.status = 'active' and u.role = 'student' where e.course_id = s.course_id) as enrolled
         from class_sessions s join courses c on c.id = s.course_id left join rooms r on r.id = s.room_id
        where s.id = $1`,
      [p.session_id],
    );
    const c = s.rows[0];
    const cls = c ? { courseCode: c.code, courseTitle: c.title, room: c.room, lectureNo: c.lecture_no, sessionCode: c.short_code } : null;
    if (!c || c.status !== 'live' || c.mode !== 'qr') return { status: 'ended' as const, class: cls };
    const seq = currentQrSeq(t, c.rotation_s);
    const token = encodeQrToken(new Uint8Array(c.qr_secret), p.session_id, seq);
    const svg = await QRCode.toString(token, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    return {
      status: 'live' as const,
      class: cls,
      qr: { svg, seq: seqLabel(seq), msLeft: msUntilNextRotation(t, c.rotation_s), rotationS: c.rotation_s },
      counts: { marked: c.marked, enrolled: c.enrolled },
    };
  });

  // ── the teacher ──

  app.post('/v1/staff/present/lookup', { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: perDeviceKey } } }, async (req) => {
    await requireDevice(req, deps, STAFF);
    const { code } = PresentCodeBody.parse(req.body);
    const { rows } = await deps.db.query<PairingRow>('select * from present_pairings where code_hash = $1', [codeHash(code)]);
    const p = rows[0];
    if (!p || p.approved_at || p.revoked_at || p.expires_at.getTime() < now())
      throw new ApiError(404, 'NOT_FOUND', 'No screen is waiting with that code. Check the code, or reload the page on the screen for a new one.');
    return { id: p.id, device: describeDevice(p.user_agent ?? undefined), ip: maskIp(p.ip), requestedAt: p.created_at.toISOString(), approvedAt: null, approvedBy: null } satisfies PresentScreen;
  });

  app.get('/v1/staff/sessions/:id/screens', async (req): Promise<PresentScreen[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    await loadSessionFor(deps.db, auth, id);
    return screensOf(deps.db, id);
  });

  app.post('/v1/staff/sessions/:id/screens', { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: perDeviceKey } } }, async (req): Promise<PresentScreen[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const { code } = PresentCodeBody.parse(req.body);
    return withTx(deps.db, async (tx) => {
      const s = await loadSessionFor(tx, auth, id);
      if (s.status !== 'live' || s.mode !== 'qr') throw new ApiError(409, 'CONFLICT', 'Start the class with QR first, then connect a screen.');
      const { rows } = await tx.query<PairingRow>('select * from present_pairings where code_hash = $1 for update', [codeHash(code)]);
      const p = rows[0];
      if (!p || p.approved_at || p.revoked_at || p.expires_at.getTime() < now())
        throw new ApiError(404, 'NOT_FOUND', 'That code has expired or was already used. Reload the page on the screen for a new one.');
      await tx.query('update present_pairings set tenant_id = $2, session_id = $3, approved_by = $4, approved_at = $5 where id = $1', [p.id, auth.tenantId, id, auth.userId, new Date(now())]);
      await audit(tx, auth, 'present.approve', `session:${id}`, { pairing: p.id, device: describeDevice(p.user_agent ?? undefined), ip: maskIp(p.ip), by: auth.deviceFingerprint });
      return screensOf(tx, id);
    });
  });

  app.post('/v1/staff/sessions/:id/screens/:pairingId/disconnect', async (req): Promise<PresentScreen[]> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id, pairingId } = z.object({ id: z.uuid(), pairingId: z.uuid() }).parse(req.params);
    return withTx(deps.db, async (tx) => {
      await loadSessionFor(tx, auth, id);
      const r = await tx.query('update present_pairings set revoked_at = $3, revoked_by = $4 where id = $1 and session_id = $2 and revoked_at is null', [pairingId, id, new Date(now()), auth.userId]);
      if (r.rowCount) await audit(tx, auth, 'present.disconnect', `session:${id}`, { pairing: pairingId });
      return screensOf(tx, id);
    });
  });
}

// ───────────────────────────── the page ─────────────────────────────

export const PRESENT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Attendly · Class screen</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #050814; color: #e8ecf6; font: 16px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 3vh 4vw; gap: 2.2vh; text-align: center; }
  .brand { position: fixed; top: 18px; left: 22px; font-weight: 700; letter-spacing: .02em; color: #22d3ee; }
  .brand span { color: #8b93a7; font-weight: 500; }
  h1 { margin: 0; font-size: clamp(22px, 3.2vw, 44px); font-weight: 700; }
  p { margin: 0; color: #8b93a7; font-size: clamp(15px, 1.6vw, 22px); max-width: 60ch; }
  .code { font: 700 clamp(48px, 11vw, 160px)/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .08em; color: #fff; padding: 2vh 3vw; border: 2px solid rgba(34,211,238,.35); border-radius: 24px; background: rgba(34,211,238,.06); }
  ol { text-align: left; color: #c5cbe0; font-size: clamp(15px, 1.6vw, 22px); margin: 0; padding-left: 1.4em; }
  .qr { background: #fff; border-radius: 22px; padding: 1.2vh; width: min(78vh, 90vw); aspect-ratio: 1; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .row { display: flex; gap: 3vw; align-items: baseline; justify-content: center; flex-wrap: wrap; }
  .seq { font: 600 clamp(18px, 2vw, 28px) ui-monospace, Menlo, Consolas, monospace; }
  .count { font-weight: 800; font-size: clamp(26px, 3.4vw, 52px); color: #34d399; }
  .muted { color: #8b93a7; }
  .bar { width: min(78vh, 90vw); height: 6px; border-radius: 3px; background: #1a2238; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #22d3ee; width: 100%; transition: width .25s linear; }
  button { font: 600 16px system-ui, sans-serif; color: #04141c; background: #22d3ee; border: 0; border-radius: 12px; padding: 12px 20px; cursor: pointer; }
  button.ghost { background: transparent; color: #8b93a7; border: 1px solid #28314a; }
  .hidden { display: none !important; }
  .warn { color: #fbbf24; }
</style>
</head>
<body>
<div class="brand">Attendly <span>· class screen</span></div>
<main id="pair">
  <h1>Show attendance on this screen</h1>
  <p>In the <b>Attendly Institute</b> app, open your live class, tap <b>Big screen</b> and enter this code:</p>
  <div class="code" id="code">····-····</div>
  <p id="expiry" class="muted"></p>
  <p class="muted">Only the teacher’s approved phone can connect this screen. The code works once.</p>
</main>
<main id="live" class="hidden">
  <h1 id="title"></h1>
  <div class="qr" id="qr" aria-label="Attendance QR code"></div>
  <div class="bar"><i id="bar"></i></div>
  <div class="row"><span class="seq" id="seq"></span><span class="count" id="count"></span></div>
  <p>Scan with the <b>Attendly</b> app. The code changes every few seconds — photos of it stop working.</p>
  <div class="row"><button class="ghost" id="fs">Full screen</button></div>
</main>
<main id="done" class="hidden">
  <h1 id="doneTitle">Class ended</h1>
  <p id="doneText">This screen has been disconnected.</p>
  <button id="again">Connect for another class</button>
</main>
<script src="/present.js"></script>
</body>
</html>`;

export const PRESENT_JS = `(function () {
  'use strict';
  var KEY = 'attendly.present.v1';
  var $ = function (id) { return document.getElementById(id); };
  var state = null, timer = null, failures = 0;
  function show(id) { ['pair', 'live', 'done'].forEach(function (x) { $(x).classList.toggle('hidden', x !== id); }); }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
  function done(title, text) { clearTimeout(timer); state = null; save(); $('doneTitle').textContent = title; $('doneText').textContent = text; show('done'); }

  function pair() {
    show('pair'); $('code').textContent = '····-····'; $('expiry').textContent = '';
    fetch('/v1/present/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { state = { id: j.pairingId, secret: j.secret, code: j.code, expiresAt: j.expiresAt }; save(); $('code').textContent = j.code; poll(); })
      .catch(function () { $('expiry').innerHTML = '<span class="warn">Can’t reach the server. Retrying…</span>'; setTimeout(pair, 5000); });
  }

  function poll() {
    if (!state) return pair();
    fetch('/v1/present/' + encodeURIComponent(state.id), { headers: { 'x-present-secret': state.secret }, cache: 'no-store' })
      .then(function (r) { if (r.status === 404) return { status: 'gone' }; if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        failures = 0;
        if (j.status === 'waiting') {
          show('pair'); $('code').textContent = state.code;
          var left = Math.max(0, Math.round((Date.parse(j.expiresAt) - Date.now()) / 1000));
          $('expiry').textContent = 'Code expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
          return schedule(1500);
        }
        if (j.status === 'live') {
          if (!state.approved) { state.approved = true; save(); }
          show('live');
          $('title').textContent = j.class.courseCode + ' · ' + j.class.courseTitle + (j.class.lectureNo ? ' · Lecture ' + j.class.lectureNo : '');
          $('qr').innerHTML = j.qr.svg;
          $('seq').textContent = j.qr.seq;
          $('count').textContent = j.counts.marked + ' / ' + j.counts.enrolled + ' present';
          $('bar').style.width = Math.round((j.qr.msLeft / (j.qr.rotationS * 1000)) * 100) + '%';
          return schedule(Math.min(1000, j.qr.msLeft + 60));
        }
        if (j.status === 'expired') return state && !state.approved ? pair() : done('Session expired', 'Connect again from the app to keep showing the code.');
        if (j.status === 'ended') return done('Class ended', 'The teacher ended ' + (j.class ? j.class.courseCode : 'the class') + '. The code is no longer valid.');
        if (j.status === 'disconnected') return done('Disconnected', 'The teacher disconnected this screen.');
        return pair();
      })
      .catch(function () {
        failures++;
        $('qr').innerHTML = failures > 3 ? '<p class="warn" style="padding:2em">Connection lost — reconnecting…</p>' : $('qr').innerHTML;
        schedule(Math.min(10000, 1000 * failures));
      });
  }

  $('again').addEventListener('click', function () { state = null; save(); pair(); });
  $('fs').addEventListener('click', function () { var d = document.documentElement; if (d.requestFullscreen) d.requestFullscreen().catch(function () {}); });
  state = load();
  if (state) poll(); else pair();
})();`;
