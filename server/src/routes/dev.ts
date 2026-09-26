/**
 * DEVELOPMENT / TESTING ONLY.
 *
 * A tiny faculty console served by the API so the Student app can be tested
 * end-to-end before the Admin app exists. Enabled only when DEV_TOOLS_TOKEN is
 * set; every call must present that token. Never enable it on a real
 * deployment — the Admin app replaces it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { currentQrSeq, encodeQrToken, msUntilNextRotation, timingSafeEqual, utf8ToBytes } from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx } from '../db';
import { appendAudit } from '../lib/audit';
import { ApiError } from '../lib/errors';
import { createSession } from '../lib/sessions';

const StartBody = z.object({
  courseId: z.uuid(),
  room: z.string().trim().min(1).max(60),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  radiusM: z.number().int().min(10).max(1000),
  rotationS: z.number().int().min(3).max(60),
  durationMin: z.number().int().min(5).max(240),
});

export async function devRoutes(app: FastifyInstance, deps: Deps) {
  const token = deps.config.devToolsToken;
  if (!token) return;
  app.log.warn('DEV TOOLS ENABLED at /dev — for testing only, never on a real deployment');

  function guard(req: FastifyRequest) {
    const given = (req.headers['x-dev-token'] as string | undefined) ?? (req.query as { token?: string } | undefined)?.token ?? '';
    if (!timingSafeEqual(utf8ToBytes(given), utf8ToBytes(token!))) throw new ApiError(404, 'NOT_FOUND');
  }

  app.get('/dev', async (req, reply: FastifyReply) => {
    guard(req);
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .send(DEV_PAGE);
  });

  app.get('/dev/api/courses', async (req) => {
    guard(req);
    const { rows } = await deps.db.query(
      `select c.id, c.code, c.title, t.name as institution, (select count(*) from enrollments e where e.course_id = c.id) as students
         from courses c join tenants t on t.id = c.tenant_id where t.status = 'active' order by t.name, c.code`,
    );
    return rows;
  });

  app.get('/dev/api/sessions', async (req) => {
    guard(req);
    const { rows } = await deps.db.query(
      `select s.id, s.short_code, s.room, s.radius_m, s.rotation_s, s.started_at, s.scheduled_end, c.code, c.title,
              (select count(*) from attendance_records a where a.session_id = s.id) as marked,
              (select count(*) from enrollments e where e.course_id = s.course_id) as enrolled
         from class_sessions s join courses c on c.id = s.course_id where s.status = 'live' order by s.started_at desc`,
    );
    return rows;
  });

  app.post('/dev/api/sessions', async (req) => {
    guard(req);
    const b = StartBody.parse(req.body);
    return withTx(deps.db, async (tx) => {
      const c = await tx.query<{ tenant_id: string }>('select tenant_id from courses where id = $1', [b.courseId]);
      if (!c.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Unknown course');
      const now = new Date(deps.clock());
      return createSession(tx, {
        tenantId: c.rows[0].tenant_id,
        courseId: b.courseId,
        room: b.room,
        lat: b.lat,
        lng: b.lng,
        radiusM: b.radiusM,
        rotationS: b.rotationS,
        status: 'live',
        scheduledStart: now,
        scheduledEnd: new Date(now.getTime() + b.durationMin * 60_000),
        startedAt: now,
        createdBy: null,
      });
    });
  });

  app.get('/dev/api/scheduled', async (req) => {
    guard(req);
    const { rows } = await deps.db.query(
      `select s.id, s.short_code, s.room, s.scheduled_start, c.code, c.title, t.timezone
         from class_sessions s join courses c on c.id = s.course_id join tenants t on t.id = s.tenant_id
        where s.status = 'scheduled' and (s.scheduled_start at time zone t.timezone)::date = (now() at time zone t.timezone)::date
        order by s.scheduled_start`,
    );
    return rows;
  });

  /** Take one of today's scheduled sessions live at the given location. */
  app.post('/dev/api/sessions/:id/start', async (req) => {
    guard(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = StartBody.omit({ courseId: true, room: true }).parse(req.body);
    return withTx(deps.db, async (tx) => {
      const now = new Date(deps.clock());
      const r = await tx.query<{ tenant_id: string; short_code: string }>(
        `update class_sessions set status = 'live', lat = $2, lng = $3, radius_m = $4, rotation_s = $5, started_at = $6,
                scheduled_end = greatest(scheduled_end, $7), scheduled_start = least(scheduled_start, $6)
          where id = $1 and status = 'scheduled' returning tenant_id, short_code`,
        [id, b.lat, b.lng, b.radiusM, b.rotationS, now, new Date(now.getTime() + b.durationMin * 60_000)],
      );
      if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Session is not scheduled');
      await appendAudit(tx, { tenantId: r.rows[0].tenant_id, actorType: 'system', action: 'session.start', subject: `session:${id}` });
      return { id, shortCode: r.rows[0].short_code };
    });
  });

  app.post('/dev/api/sessions/:id/end', async (req) => {
    guard(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await withTx(deps.db, async (tx) => {
      const r = await tx.query<{ tenant_id: string }>(
        `update class_sessions set status = 'closed', ended_at = $2 where id = $1 and status = 'live' returning tenant_id`,
        [id, new Date(deps.clock())],
      );
      if (r.rows[0]) await appendAudit(tx, { tenantId: r.rows[0].tenant_id, actorType: 'system', action: 'session.close', subject: `session:${id}` });
    });
    return { ok: true };
  });

  app.get('/dev/api/sessions/:id/qr', async (req) => {
    guard(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rows } = await deps.db.query<{
      qr_secret: Buffer;
      started_at: Date;
      rotation_s: number;
      status: string;
      short_code: string;
      room: string | null;
      radius_m: number;
      code: string;
      title: string;
      marked: number;
      enrolled: number;
    }>(
      `select s.qr_secret, s.started_at, s.rotation_s, s.status, s.short_code, s.room, s.radius_m, c.code, c.title,
              (select count(*) from attendance_records a where a.session_id = s.id) as marked,
              (select count(*) from enrollments e where e.course_id = s.course_id) as enrolled
         from class_sessions s join courses c on c.id = s.course_id where s.id = $1`,
      [id],
    );
    const s = rows[0];
    if (!s || s.status !== 'live') throw new ApiError(404, 'NOT_FOUND', 'Session is not live');
    const now = deps.clock();
    const seq = currentQrSeq(s.started_at.getTime(), now, s.rotation_s);
    const token = encodeQrToken(s.qr_secret, id, seq);
    const svg = await QRCode.toString(token, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#050814', light: '#ffffff' } });
    return {
      seq,
      token,
      svg,
      msUntilNext: msUntilNextRotation(s.started_at.getTime(), now, s.rotation_s),
      rotationS: s.rotation_s,
      shortCode: s.short_code,
      room: s.room,
      radiusM: s.radius_m,
      course: `${s.code} · ${s.title}`,
      marked: s.marked,
      enrolled: s.enrolled,
    };
  });
}

const DEV_PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Attendly · Dev faculty console</title>
<style>
  :root{--bg:#050814;--card:#0b1122;--line:#1b2440;--text:#e8ecf7;--mute:#8490ad;--cyan:#22d3ee;--violet:#8b5cf6;--green:#34d399;--red:#f87171;--amber:#fbbf24}
  *{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#0b2a3a55,transparent),var(--bg);color:var(--text);font:15px/1.45 Inter,system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}
  .wrap{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
  h1{font-size:22px;margin:0}.sub{color:var(--mute);font:12px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}
  .warn{margin:16px 0;padding:10px 14px;border:1px solid #fbbf2455;background:#fbbf2410;border-radius:12px;color:var(--amber);font-size:13px}
  .grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:16px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px}
  label{display:block;color:var(--mute);font:11px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;margin:12px 0 6px}
  input,select{width:100%;background:#070c1a;border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;font:inherit}
  .row{display:flex;gap:8px}.row>*{flex:1}
  button{cursor:pointer;border:0;border-radius:12px;padding:11px 14px;font:600 14px Inter,system-ui,sans-serif}
  .primary{background:linear-gradient(90deg,#22d3ee,#0ea5e9);color:#04121a;width:100%;margin-top:16px}
  .ghost{background:#111a33;color:var(--text);border:1px solid var(--line)}
  .danger{background:#2a0f14;color:var(--red);border:1px solid #f8717144}
  .qr{background:#fff;border-radius:16px;padding:14px;width:min(100%,420px);aspect-ratio:1;margin:8px auto}
  .qr svg{width:100%;height:100%;display:block}
  .meta{display:flex;justify-content:space-between;color:var(--mute);font:12px ui-monospace,Menlo,monospace;margin-top:8px}
  .bar{height:4px;background:#111a33;border-radius:4px;overflow:hidden;margin-top:10px}.bar>i{display:block;height:100%;background:var(--cyan);transition:width .25s linear}
  .pill{display:inline-flex;gap:6px;align-items:center;padding:3px 10px;border-radius:999px;font-size:12px;background:#22d3ee14;color:var(--cyan);border:1px solid #22d3ee33}
  .live{background:#34d39914;color:var(--green);border-color:#34d39933}
  .list .item{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-top:1px solid var(--line)}
  .muted{color:var(--mute)} .err{color:var(--red);font-size:13px;margin-top:8px;min-height:18px}
  .big{font-size:40px;font-weight:700;letter-spacing:-.02em}
</style></head><body><div class="wrap">
  <div class="sub">Attendly · developer tools</div><h1>Faculty test console</h1>
  <div class="warn">Testing only. This page stands in for the Admin app so you can test the Student app end-to-end. Disable it (unset DEV_TOOLS_TOKEN) on any real deployment.</div>
  <div class="grid">
    <div class="card">
      <b>Start a live session</b>
      <label>Course</label><select id="course"></select>
      <label>Room</label><input id="room" value="LH-2 · Block C" maxlength="60">
      <label>Geofence centre</label>
      <div class="row"><input id="lat" placeholder="Latitude" inputmode="decimal"><input id="lng" placeholder="Longitude" inputmode="decimal"></div>
      <button class="ghost" id="here" style="width:100%;margin-top:8px">Use this computer's location</button>
      <div class="row"><div><label>Radius</label><select id="radius"><option>25</option><option selected>50</option><option>100</option><option>250</option><option>1000</option></select></div>
      <div><label>Rotate every</label><select id="rot"><option value="3">3s</option><option value="5">5s</option><option value="7" selected>7s</option><option value="10">10s</option><option value="15">15s</option></select></div>
      <div><label>Duration</label><select id="dur"><option value="30">30m</option><option value="60" selected>60m</option><option value="120">120m</option></select></div></div>
      <button class="primary" id="start">Start new session →</button>
      <div class="list" id="scheduled"></div>
      <div class="err" id="err"></div>
      <div class="list" id="sessions"></div>
    </div>
    <div class="card" id="qrcard" style="text-align:center">
      <div class="muted" style="padding:80px 0">Start or open a session to display its rotating QR.</div>
    </div>
  </div>
</div>
<script>
const T = new URLSearchParams(location.search).get('token') || '';
history.replaceState(null, '', location.pathname); // keep the token out of screenshots / history
const H = {'x-dev-token': T, 'content-type': 'application/json'};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path, opts = {}) {
  const r = await fetch(path, {...opts, headers: H});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || ('HTTP ' + r.status));
  return j;
}
async function loadCourses() {
  const cs = await api('/dev/api/courses');
  $('course').innerHTML = cs.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.code + ' · ' + c.title + ' (' + c.students + ' students) — ' + c.institution) + '</option>').join('');
}
function place() {
  const lat = parseFloat($('lat').value), lng = parseFloat($('lng').value);
  if (!isFinite(lat) || !isFinite(lng)) throw new Error('Set the geofence centre first (use the button or type coordinates).');
  return {lat, lng, radiusM: +$('radius').value, rotationS: +$('rot').value, durationMin: +$('dur').value};
}
async function loadScheduled() {
  const ss = await api('/dev/api/scheduled');
  $('scheduled').innerHTML = ss.length ? '<label>Today\'s timetable</label>' + ss.map((s) =>
    '<div class="item"><div><b>' + esc(s.code) + '</b> <span class="muted">' + esc(new Date(s.scheduled_start).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})) + ' · ' + esc(s.room) + '</span></div>' +
    '<button class="ghost" data-golive="' + esc(s.id) + '">Go live here</button></div>').join('') : '';
}
$('scheduled').addEventListener('click', async (e) => {
  const g = e.target.closest('[data-golive]'); if (!g) return;
  $('err').textContent = '';
  try { const s = await api('/dev/api/sessions/' + g.dataset.golive + '/start', {method: 'POST', body: JSON.stringify(place())}); await loadScheduled(); await loadSessions(); show(s.id); }
  catch (err) { $('err').textContent = err.message; }
});
async function loadSessions() {
  const ss = await api('/dev/api/sessions');
  $('sessions').innerHTML = ss.length ? '<label>Live sessions</label>' + ss.map((s) =>
    '<div class="item"><div><b>' + esc(s.code) + '</b> <span class="muted">' + esc(s.short_code) + ' · ' + esc(s.room) + ' · ' + s.marked + '/' + s.enrolled + '</span></div>' +
    '<div class="row" style="flex:0 0 auto"><button class="ghost" data-open="' + esc(s.id) + '">Show QR</button><button class="danger" data-end="' + esc(s.id) + '">End</button></div></div>').join('') : '';
}
$('sessions').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-open]'), d = e.target.closest('[data-end]');
  if (o) show(o.dataset.open);
  if (d) { await api('/dev/api/sessions/' + d.dataset.end + '/end', {method: 'POST', body: '{}'}); if (current === d.dataset.end) stop(); loadSessions(); }
});
$('here').onclick = () => {
  $('err').textContent = '';
  if (!navigator.geolocation) return ($('err').textContent = 'Geolocation unavailable — type coordinates instead.');
  navigator.geolocation.getCurrentPosition(
    (p) => { $('lat').value = p.coords.latitude.toFixed(6); $('lng').value = p.coords.longitude.toFixed(6); },
    (e) => ($('err').textContent = 'Location failed: ' + e.message + ' (open this page via http://localhost, or type coordinates).'),
    {enableHighAccuracy: true, timeout: 15000});
};
$('start').onclick = async () => {
  $('err').textContent = '';
  try {
    const s = await api('/dev/api/sessions', {method: 'POST', body: JSON.stringify({courseId: $('course').value, room: $('room').value, ...place()})});
    await loadSessions(); show(s.id);
  } catch (e) { $('err').textContent = e.message; }
};
let current = null, timer = null, deadline = 0, period = 1;
function stop() { current = null; clearTimeout(timer); $('qrcard').innerHTML = '<div class="muted" style="padding:80px 0">Session ended.</div>'; }
async function show(id) { current = id; clearTimeout(timer); tick(); }
async function tick() {
  if (!current) return;
  try {
    const q = await api('/dev/api/sessions/' + current + '/qr');
    period = q.rotationS * 1000; deadline = Date.now() + q.msUntilNext;
    $('qrcard').innerHTML = '<div class="pill live">● LIVE · ' + esc(q.course) + '</div>' +
      '<div class="qr">' + q.svg + '</div>' +
      '<div class="meta"><span>' + esc(q.shortCode) + ' · #' + String(q.seq).padStart(4, '0') + '</span><span id="cd"></span></div>' +
      '<div class="bar"><i id="bar"></i></div>' +
      '<div style="margin-top:16px"><span class="big">' + q.marked + '</span><span class="muted"> / ' + q.enrolled + ' marked</span></div>' +
      '<div class="muted" style="font-size:13px">' + esc(q.room) + ' · ' + q.radiusM + 'm geofence · rotates every ' + q.rotationS + 's</div>';
    countdown();
    timer = setTimeout(tick, Math.min(q.msUntilNext + 50, 5000));
  } catch (e) { $('qrcard').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; current = null; }
}
function countdown() {
  const left = Math.max(0, deadline - Date.now()); const cd = $('cd'), bar = $('bar');
  if (!cd || !bar) return;
  cd.textContent = Math.ceil(left / 1000) + 's'; bar.style.width = (100 * left / period) + '%';
  if (left > 0 && current) requestAnimationFrame(countdown);
}
loadCourses().then(loadScheduled).then(loadSessions).catch((e) => ($('err').textContent = e.message));
setInterval(() => loadSessions().catch(() => {}), 5000);
</script></body></html>`;
