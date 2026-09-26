/**
 * Instant phone notifications through Firebase Cloud Messaging (HTTP v1).
 *
 * Every notification row is sent by a small dispatcher *after* its transaction commits
 * (it reads committed rows only), so a rolled-back change never buzzes anyone. Without
 * FCM_SERVICE_ACCOUNT the dispatcher does nothing and the apps' own checks deliver instead.
 */
import { createSign } from 'node:crypto';
import type { Db } from '../db';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw?.trim()) return null;
  try {
    const j = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as ServiceAccount;
    return j.project_id && j.client_email && j.private_key ? { ...j, private_key: j.private_key.replace(/\\n/g, '\n') } : null;
  } catch {
    return null;
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function createPushSender(sa: ServiceAccount, log: (msg: string, extra?: unknown) => void) {
  let token: { value: string; exp: number } | null = null;
  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (token && token.exp - 60 > now) return token.value;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
    });
    if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, exp: now + j.expires_in };
    return token.value;
  }
  /** Returns false when the token is dead (app uninstalled) so it can be forgotten. */
  async function send(to: string, n: { title: string; body: string; data: Record<string, string> }): Promise<boolean> {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: to,
          notification: { title: n.title, body: n.body },
          data: n.data,
          android: { priority: 'HIGH', notification: { channel_id: 'timetable-alerts', sound: 'default', default_vibrate_timings: true, notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC' } },
          apns: { payload: { aps: { sound: 'default' } } },
        },
      }),
    });
    if (res.status === 404 || res.status === 400) return false;
    if (!res.ok) log('FCM send failed', { status: res.status });
    return true;
  }
  return { send };
}

/** Sends every committed, not-yet-pushed notification of the last 10 minutes. */
export function startPushDispatcher(db: Db, sender: ReturnType<typeof createPushSender>, log: (msg: string, extra?: unknown) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await db.query<{ id: string; user_id: string; kind: string; title: string; body: string; data: Record<string, unknown> }>(
        `update notifications set pushed_at = now()
          where id in (select id from notifications where pushed_at is null and created_at > now() - interval '10 minutes' order by id limit 200 for update skip locked)
          returning id, user_id, kind, title, body, data`,
      );
      if (!rows.length) return;
      const tokens = await db.query<{ user_id: string; token: string; device_id: string }>(
        `select p.user_id, p.token, p.device_id from push_tokens p join devices d on d.id = p.device_id and d.status = 'active' where p.user_id = any($1::uuid[])`,
        [[...new Set(rows.map((r) => r.user_id))]],
      );
      for (const n of rows) {
        const first = (n.data.changes as { sessionId?: string | null; courseId?: string }[] | undefined)?.[0];
        const data: Record<string, string> = {
          notificationId: String(n.id),
          kind: n.kind,
          ...(first?.sessionId ? { sessionId: first.sessionId } : typeof n.data.sessionId === 'string' ? { sessionId: n.data.sessionId } : {}),
          ...(first?.courseId ? { courseId: first.courseId } : {}),
          ...(typeof n.data.requestId === 'string' ? { requestId: n.data.requestId } : {}),
        };
        for (const t of tokens.rows.filter((x) => x.user_id === n.user_id)) {
          const alive = await sender.send(t.token, { title: n.title, body: n.body, data }).catch((err: Error) => (log('FCM error', { err: err.message }), true));
          if (!alive) await db.query('delete from push_tokens where device_id = $1', [t.device_id]);
        }
      }
    } catch (err) {
      log('push dispatcher error', { err: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), 2000);
  return () => clearInterval(t);
}
